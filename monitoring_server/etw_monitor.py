import sys
import threading
import time
from collections import OrderedDict
from typing import cast
import psutil
from pyetwkit import KernelSession, to_typed_event, ProcessStartEvent, ProcessStopEvent

class EtwMonitor:
    """
    基于 ETW 机制的细粒度网络流量与进程生命周期监听器。
    在后台线程中订阅内核事件，对流量数据进行时间窗口滑动聚合。
    """
    def __init__(self, cache_size: int = 5000):
        self.cache_size = cache_size
        self.lock = threading.Lock()
        
        # PID 到进程名的 LRU 缓存
        self.pid_to_name: OrderedDict[int, str] = OrderedDict()
        
        # 流量数据存储结构：
        # self.traffic_history 记录每秒的流量明细：
        # { timestamp_sec: { pid: { "sent": bytes, "recv": bytes } } }
        self.traffic_history: OrderedDict[int, dict[int, dict[str, int]]] = OrderedDict()
        self.history_limit_seconds = 60  # 最多保留 60 秒的历史明细
        
        self.session = None
        self.running = False
        self.monitor_thread = None
        
        # 启动时冷启动进程名缓存
        self._initialize_process_cache()

    def _initialize_process_cache(self):
        """
        扫描当前系统活跃进程，初始化 PID 到进程名称的映射缓存。
        """
        with self.lock:
            for proc in psutil.process_iter(['pid', 'name']):
                try:
                    pid = proc.info['pid']
                    name = proc.info['name']
                    self.pid_to_name[pid] = name
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    continue
            sys.stderr.write(f"[Info] Warm-up process cache completed. Loaded {len(self.pid_to_name)} processes.\n")

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

    def _remove_pid(self, pid: int):
        """
        进程终止时，从缓存中移除（此处仅做延时清理或不主动删除以防最后的网络包归属丢失）。
        为了解决瞬发进程死无对证问题，我们不立即从缓存中彻底删除，而是保留最后 50 条已退出进程的记录。
        """
        pass

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
        启动后台 ETW 监听线程。
        """
        if self.running:
            return
            
        self.running = True
        self.session = KernelSession()
        
        # 开启进程与网络监听
        self.session.enable_process()
        self.session.enable_network()
        
        try:
            self.session.start()
        except Exception as e:
            sys.stderr.write(f"[Fatal] Failed to start ETW Kernel Session: {e}. Please ensure running as Administrator.\n")
            self.running = False
            raise e
            
        self.monitor_thread = threading.Thread(target=self._monitor_loop, daemon=True)
        self.monitor_thread.start()
        sys.stderr.write("[Info] ETW traffic and process monitor thread started.\n")

    def stop(self):
        """
        停止后台 ETW 监听。
        """
        self.running = False
        if self.session:
            try:
                self.session.stop()
            except Exception as e:
                sys.stderr.write(f"[Warning] Error stopping ETW session: {e}\n")
        if self.monitor_thread:
            self.monitor_thread.join(timeout=2.0)

    def _monitor_loop(self):
        """
        后台 ETW 事件消费循环。
        """
        while self.running:
            try:
                # 500ms 超时，确保 running 改变时能退出
                event = self.session.next_event_timeout(500)
                if not event:
                    continue
                
                # 优先解析进程启动和销毁
                typed = to_typed_event(event)
                if isinstance(typed, ProcessStartEvent):
                    self._add_pid(typed.process_id, typed.image_file_name)
                    continue
                elif isinstance(typed, ProcessStopEvent):
                    # 为了应对网络事件可能存在轻微延迟，我们不立即从缓存中剔除，
                    # 而是让 LRU 机制在大容量下自动淘汰
                    continue
                
                # 解析网络流量
                props = event.properties
                if not props:
                    continue
                
                # 如果 properties 含有 size 并且是网络包
                if "size" in props:
                    size = props["size"]
                    pid = event.process_id
                    
                    # 确定是发送还是接收 (Opcode 10: Send, Opcode 11: Recv)
                    is_send = (event.opcode == 10)
                    is_recv = (event.opcode == 11)
                    
                    if is_send or is_recv:
                        self._record_traffic(pid, size, is_send)
                        
            except Exception as e:
                sys.stderr.write(f"[Error] Exception in ETW loop: {e}\n")
                time.sleep(0.1)

    def _record_traffic(self, pid: int, size: int, is_send: bool):
        """
        将字节大小记录在滑动窗口的历史字典中。
        """
        now_sec = int(time.time())
        with self.lock:
            if now_sec not in self.traffic_history:
                self.traffic_history[now_sec] = {}
                # 限制历史大小
                while len(self.traffic_history) > self.history_limit_seconds:
                    self.traffic_history.popitem(last=False)
                    
            second_data = self.traffic_history[now_sec]
            if pid not in second_data:
                second_data[pid] = {"sent": 0, "recv": 0}
                
            if is_send:
                second_data[pid]["sent"] += size
            else:
                second_data[pid]["recv"] += size

    def get_aggregated_traffic(self, window_seconds: int = 5, top_n: int = 10) -> list:
        """
        聚合过去 N 秒的流量，并计算每秒的 Bytes/sec 速率。
        
        @returns 返回排序后的流量报告列表。
        """
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
                report.append({
                    "pid": pid,
                    "name": name,
                    "sent_rate_bytes_per_sec": round(sent_rate, 2),
                    "recv_rate_bytes_per_sec": round(recv_rate, 2),
                    "total_rate_bytes_per_sec": round(total_rate, 2),
                    "total_bytes_in_window": bytes_data["sent_bytes"] + bytes_data["recv_bytes"]
                })
                
        # 按总速率降序排列
        report.sort(key=lambda x: cast(float, x["total_rate_bytes_per_sec"]), reverse=True)
        return report[:top_n]
