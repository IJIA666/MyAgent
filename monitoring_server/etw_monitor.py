import sys
import os
import json
import subprocess
import threading
import time
from collections import OrderedDict
from typing import cast
import psutil

# 仅在 Windows 平台上导入 win32job 和 win32handle
try:
    import win32job
    import win32handle
except ImportError:
    win32job = None
    win32handle = None


class EtwMonitor:
    """
    管道数据接收与生命周期管理类。
    通过子进程 `etw_collector.py` 捕获 Windows ETW 网络流量，
    主进程采用非阻塞线程读取数据，完全规避解释器 GIL 锁死问题；
    引入 Job Object 确保主子进程生命周期严格绑定。
    """

    def __init__(self, cache_size: int = 5000):
        self.cache_size = cache_size
        self.lock = threading.Lock()

        # PID 到进程名的 LRU 缓存
        self.pid_to_name: OrderedDict[int, str] = OrderedDict()

        # 流量数据存储结构：
        # self.traffic_history 记录每秒的流量明细：
        # { timestamp_sec: { pid: { "sent": bytes, "recv": bytes } } }
        self.traffic_history: OrderedDict[int, dict[int, dict[str, int]]] = (
            OrderedDict()
        )
        self.history_limit_seconds = 60  # 最多保留 60 秒的历史明细

        self.process = None
        self.h_job = None
        self.running = False

        self.stdout_thread = None
        self.stderr_thread = None
        self.last_stderr_log = ""

        # 启动时冷启动进程名缓存
        self._initialize_process_cache()

    def _initialize_process_cache(self):
        """
        扫描当前系统活跃进程，初始化 PID 到进程名称的映射缓存。
        """
        with self.lock:
            for proc in psutil.process_iter(["pid", "name"]):
                try:
                    pid = proc.info["pid"]
                    name = proc.info["name"]
                    self.pid_to_name[pid] = name
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    continue
            sys.stderr.write(
                f"[信息] 预热进程缓存完成。已加载 {len(self.pid_to_name)} 个进程。\n"
            )

    def _add_pid(self, pid: int, name: str):
        """
        向缓存中添加 PID。若超过容量限制则踢出最旧项。
        """
        with self.lock:
            if pid in self.pid_to_name:
                self.pid_to_name.move_to_end(pid)
            self.pid_to_name[pid] = name
            if len(self.pid_to_name) > self.cache_size:
                self.pid_to_name.popitem(last=False)

    def get_process_name(self, pid: int) -> str:
        """
        通过 PID 获取进程名。若缓存中没有，则尝试通过 psutil 实时获取。
        """
        with self.lock:
            if pid in self.pid_to_name:
                self.pid_to_name.move_to_end(pid)
                return self.pid_to_name[pid]

        # 尝试实时获取并缓存
        try:
            proc = psutil.Process(pid)
            name = proc.name()
            self._add_pid(pid, name)
            return name
        except Exception:
            return "Unknown"

    def start(self):
        """
        启动后台流量监听。以子进程形式启动 etw_collector.py 并绑定 Job Object。
        """
        if self.running:
            return

        self.running = True
        self.last_stderr_log = ""

        # 1. 确定 etw_collector.py 脚本路径
        current_dir = os.path.dirname(os.path.abspath(__file__))
        collector_path = os.path.join(current_dir, "etw_collector.py")

        # 2. 强制添加 PYTHONUNBUFFERED=1 环境变量，防止标准输出发生阻塞延迟
        env = os.environ.copy()
        env["PYTHONUNBUFFERED"] = "1"

        sys.stderr.write(
            f"[信息] 正在启动 ETW 收集器子进程: {sys.executable} {collector_path}\n"
        )
        try:
            self.process = subprocess.Popen(
                [sys.executable, collector_path],
                stdin=subprocess.DEVNULL,  # 显式隔离 stdin 流以防管道争抢卡死
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=env,
            )
        except Exception as e:
            self.running = False
            raise RuntimeError(f"启动 ETW 收集器子进程失败: {e}")

        # 3. 关联 Windows Job Object 实现操作系统级强杀绑定
        if win32job and win32handle:
            try:
                # 创建匿名 Job Object
                self.h_job = win32job.CreateJobObject(None, "")

                # 配置退出强杀标志
                info = win32job.QueryInformationJobObject(
                    self.h_job, win32job.JobObjectExtendedLimitInformation
                )
                info["BasicLimitInformation"]["LimitFlags"] |= (
                    win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                )
                win32job.SetInformationJobObject(
                    self.h_job, win32job.JobObjectExtendedLimitInformation, info
                )

                # 绑定子进程句柄
                win32job.AssignProcessToJobObject(self.h_job, self.process._handle)
                sys.stderr.write(
                    "[信息] ETW 收集器子进程成功绑定到 Job Object。\n"
                )
            except Exception as e:
                sys.stderr.write(
                    f"[警告] 绑定子进程到 Job Object 失败: {e}\n"
                )

        # 4. 开启异步读取线程
        self.stdout_thread = threading.Thread(
            target=self._stdout_reader_loop, daemon=True
        )
        self.stdout_thread.start()

        self.stderr_thread = threading.Thread(
            target=self._stderr_reader_loop, daemon=True
        )
        self.stderr_thread.start()

        # 5. 等待 0.5 秒预检子进程是否因为权限不足或启动异常而闪退退出
        time.sleep(0.5)
        exit_code = self.process.poll()
        if exit_code is not None:
            self.running = False
            # 关闭 Job 句柄
            if self.h_job:
                try:
                    self.h_job.Close()
                except Exception:
                    pass
                self.h_job = None
            raise RuntimeError(
                f"ETW 收集器子进程提前退出，退出码 {exit_code}。标准错误输出: {self.last_stderr_log.strip()}"
            )

        sys.stderr.write("[信息] ETW 收集器子进程正在运行。监控器初始化完成。\n")

    def stop(self):
        """
        优雅停止流量监听并销毁管道及 Job 句柄。
        """
        self.running = False

        if self.process:
            sys.stderr.write("[信息] 正在终止 ETW 收集器子进程...\n")
            try:
                self.process.terminate()
                self.process.wait(timeout=1.0)
            except Exception:
                try:
                    self.process.kill()
                except Exception:
                    pass
            self.process = None

        if self.h_job:
            try:
                # 关闭句柄，系统将自动终止关联在 Job 内的子进程
                self.h_job.Close()
            except Exception:
                pass
            self.h_job = None

        sys.stderr.write("[信息] ETW 流量监控已停止。\n")

    def _stdout_reader_loop(self):
        """
        非阻塞读取子进程标准输出的守护线程循环。
        """
        while self.running and self.process:
            try:
                line = self.process.stdout.readline()
                if not line:
                    break

                data = json.loads(line)
                ts = data["ts"]
                traffic = data["traffic"]

                # 转换 string PID 为 int PID
                converted_traffic = {}
                for pid_str, flow in traffic.items():
                    converted_traffic[int(pid_str)] = flow

                with self.lock:
                    self.traffic_history[ts] = converted_traffic
                    # 限制历史滑动窗口大小
                    while len(self.traffic_history) > self.history_limit_seconds:
                        self.traffic_history.popitem(last=False)

            except Exception:
                # 忽略任何损坏的单行输出
                continue

    def _stderr_reader_loop(self):
        """
        非阻塞读取子进程标准错误输出的守护线程循环。
        """
        while self.running and self.process:
            try:
                line = self.process.stderr.readline()
                if not line:
                    break
                self.last_stderr_log += line
                sys.stderr.write(f"[Collector-Stderr] {line}")
            except Exception:
                break

    def get_aggregated_traffic(self, window_seconds: int = 5, top_n: int = 10) -> list:
        """
        聚合过去 N 秒的流量，并计算每秒的 Bytes/sec 速率。

        @returns 返回排序后的流量报告列表。
        """
        # 动态健康检验：若进程已于 0.5s 预检后闪退，主动降级并抛出异常
        if self.running and self.process:
            exit_code = self.process.poll()
            if exit_code is not None:
                self.running = False
                if self.h_job:
                    try:
                        self.h_job.Close()
                    except Exception:
                        pass
                    self.h_job = None
                raise RuntimeError(
                    f"ETW 收集器子进程崩溃或提前退出，退出码 {exit_code}。标准错误输出: {self.last_stderr_log.strip()}"
                )

        now_sec = int(time.time())
        start_sec = now_sec - window_seconds

        aggregated = {}

        with self.lock:
            # 汇总指定时间窗口内的流量
            for ts, data in self.traffic_history.items():
                if ts >= start_sec:
                    for pid, flow in data.items():
                        if pid not in aggregated:
                            aggregated[pid] = {"sent_bytes": 0, "recv_bytes": 0}
                        aggregated[pid]["sent_bytes"] += flow["sent"]
                        aggregated[pid]["recv_bytes"] += flow["recv"]

        report = []
        for pid, bytes_data in aggregated.items():
            sent_rate = bytes_data["sent_bytes"] / window_seconds
            recv_rate = bytes_data["recv_bytes"] / window_seconds
            total_rate = sent_rate + recv_rate

            if total_rate > 0:
                name = self.get_process_name(pid)
                report.append(
                    {
                        "pid": pid,
                        "name": name,
                        "sent_rate_bytes_per_sec": round(sent_rate, 2),
                        "recv_rate_bytes_per_sec": round(recv_rate, 2),
                        "total_rate_bytes_per_sec": round(total_rate, 2),
                        "total_bytes_in_window": bytes_data["sent_bytes"]
                        + bytes_data["recv_bytes"],
                    }
                )

        # 按总速率降序排列
        report.sort(
            key=lambda x: cast(float, x["total_rate_bytes_per_sec"]), reverse=True
        )
        return report[:top_n]
