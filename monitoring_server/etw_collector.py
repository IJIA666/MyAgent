"""
@fileoverview Windows ETW 网络流量采集子进程。
专职负责以管理员特权启动 pyetwkit 进行流量事件监听，在子进程中局部聚合网速，
降低 I/O 开销并以单行 JSON 的格式通过 stdout 每秒冲刷上报，彻底解决 GIL 挂起。

使用 EtwSession + KernelProvider.network() 监听 TcpIp 事件。由于 pyetwkit v3.0.1 的 manifest-based
provider 无法解析事件属性（properties 始终为空字典，不含 size 字段），而 KernelSession
在当前版本中存在自动停止的 bug，因此采用事件计数模式：每个 send/recv 事件
计为 1 个单位（代表一个网络包），上层显示为“网络活跃度”而非精确字节数。
"""
import sys
import os
import time
import json
import ctypes
import threading
import psutil
from pyetwkit import EtwSession, KernelProvider

# 局部流量累加缓存与线程锁
buffer_lock = threading.Lock()
traffic_buffer = {}

def is_admin() -> bool:
    """
    检测当前进程是否拥有 Windows 管理员权限。
    """
    try:
        return ctypes.windll.shell32.IsUserAnAdmin() != 0
    except Exception:
        return False

def collector_thread(session: EtwSession):
    """
    后台消费线程，阻塞读取 ETW 事件并累加到缓冲区。
    KernelProvider.network() 的 TcpIp 事件中，opcode 10 = Send，opcode 11 = Recv。
    由于 pyetwkit v3.0.1 的 manifest-based provider 无法解析 properties（始终为空），
    采用事件计数模式：每个事件计为 1 个单位（代表一个网络包）。
    """
    global traffic_buffer
    sys.stderr.write("[信息] ETW 收集器事件线程已启动。\n")

    while True:
        try:
            # 500ms 超时限制，防止卡死
            event = session.next_event_timeout(500)
            if not event:
                continue

            pid = event.process_id

            # Opcode 10: Send, Opcode 11: Recv（TcpIp 事件定义）
            is_send = (event.opcode == 10)
            is_recv = (event.opcode == 11)

            if is_send or is_recv:
                # 由于 properties 无法解析 size，每个事件计为 1 个单位（网络包计数）
                with buffer_lock:
                    if pid not in traffic_buffer:
                        traffic_buffer[pid] = {"sent": 0, "recv": 0}
                    if is_send:
                        traffic_buffer[pid]["sent"] += 1
                    else:
                        traffic_buffer[pid]["recv"] += 1

        except Exception as e:
            sys.stderr.write(f"[错误] ETW 收集器线程中发生异常: {e}\n")
            time.sleep(0.1)

def start_parent_watchdog():
    """
    启动父进程生命周期监听看门狗。
    
    获取当前进程的父进程 PID（即监控主进程），启动后台守护线程，
    每隔 2 秒检测一次。一旦发现主进程退出，强制自毁当前子进程，释放 ETW 资源。
    """
    parent_pid = os.getppid()
    if parent_pid <= 1:
        return

    try:
        parent_proc = psutil.Process(parent_pid)
        parent_create_time = parent_proc.create_time()
    except Exception:
        # 获取父进程实例或启动时间失败，直接强制退出
        os._exit(0)

    def watchdog_loop():
        """
        后台看门狗轮询循环。
        """
        while True:
            time.sleep(2)
            try:
                # 1. 基础存在性检测
                exists = psutil.pid_exists(parent_pid)
                if not exists:
                    os._exit(0)

                # 2. 进程对象校验与启动时间比对
                is_running = False
                try:
                    p = psutil.Process(parent_pid)
                    # 校验启动时间，确保 PID 没有被操作系统重用给新启动的其他进程
                    if p.create_time() != parent_create_time:
                        os._exit(0)
                    is_running = p.is_running()
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    # 无法访问或找不到进程，说明原父进程已消亡
                    os._exit(0)

                if not is_running:
                    os._exit(0)
            except Exception:
                os._exit(0)

    # 启动看门狗守护线程
    t = threading.Thread(target=watchdog_loop, daemon=True)
    t.start()

def main():
    global traffic_buffer
    # 1. 启动父进程生命周期监听，防止主进程异常时沦为孤儿进程
    start_parent_watchdog()
    
    # 2. 管理员特权强预检 (Fail-Fast)
    if not is_admin():
        sys.stderr.write("[致命错误] ETW 收集器需要管理员权限。\n")
        sys.exit(1)
        
    sys.stderr.write("[信息] 管理员权限已验证。正在初始化 ETW 网络会话...\n")

    # 3. 启动 ETW 监听：使用 EtwSession + KernelProvider.network()
    #    能正确捕获 TcpIp 事件（opcode 10=Send, 11=Recv, pid 准确），
    #    但 properties 为空（pyetwkit manifest-based 已知限制），改用事件计数模式。
    session = EtwSession("MyNetworkCollectorSession")
    kernel_net_prov = KernelProvider.network()
    kernel_net_prov.level(5)
    session.add_provider(kernel_net_prov)

    try:
        session.start()
        sys.stderr.write("[信息] ETW 网络会话启动成功。\n")
    except Exception as e:
        sys.stderr.write(f"[致命错误] 启动 ETW 网络会话失败: {e}\n")
        sys.exit(1)

    # 3. 启动后台捕获线程
    t = threading.Thread(target=collector_thread, args=(session,), daemon=True)
    t.start()
    
    # 4. 主线程定时（每 1 秒）将局部汇总流量写入 stdout 并冲刷缓冲区
    last_flush_time = time.time()
    try:
        while True:
            time.sleep(0.1)
            now = time.time()
            if now - last_flush_time >= 1.0:
                with buffer_lock:
                    if traffic_buffer:
                        # 仅输出有流量发生的进程以精简 payload
                        out_data = {
                            "ts": int(now),
                            "traffic": traffic_buffer
                        }
                        sys.stdout.write(json.dumps(out_data) + "\n")
                        sys.stdout.flush()
                        traffic_buffer = {}
                last_flush_time = now
    except KeyboardInterrupt:
        sys.stderr.write("[信息] ETW 收集器被键盘中断。\n")
    finally:
        sys.stderr.write("[信息] 正在停止 ETW 会话...\n")
        try:
            session.stop()
        except Exception:
            pass

if __name__ == "__main__":
    main()
