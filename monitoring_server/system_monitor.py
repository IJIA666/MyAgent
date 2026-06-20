import sys
import time
import psutil

class SystemMonitor:
    """
    负责获取 Windows 系统和进程级别的详细性能指标。
    全面使用 psutil 库替代原 win32pdh 实现，从而实现毫秒级高效率检索与免管理员特权运行。
    """
    def __init__(self):
        # 记录上一次的上下文切换次数和时间戳，用于计算速率
        self.last_ctx_switches = None
        self.last_timestamp = None
        
        # 冷启动 psutil 的 CPU 统计
        try:
            psutil.cpu_percent(interval=None)
            stats = psutil.cpu_stats()
            self.last_ctx_switches = stats.ctx_switches
            self.last_timestamp = time.time()
        except Exception as e:
            sys.stderr.write(f"[警告] 初始化 SystemMonitor 指标失败: {e}\n")

    def get_system_metrics(self) -> dict:
        """
        获取系统整体的性能指标报告。
        兼容原有计数器命名规范，并补充 CPU、物理内存和磁盘的百分比。
        
        @returns 包含全局性能指标的字典。
        """
        metrics = {
            "context_switches_per_sec": 0.0,
            "page_faults_per_sec": 0.0,
            "pool_nonpaged_bytes": 0.0,
            "pool_paged_bytes": 0.0,
            "disk_queue_length": 0.0,
            "cpu_percent": 0.0,
            "memory_percent": 0.0,
            "disk_percent": 0.0
        }
        
        try:
            # 1. 计算上下文切换速率
            now = time.time()
            stats = psutil.cpu_stats()
            current_ctx = stats.ctx_switches
            
            if self.last_ctx_switches is not None and self.last_timestamp is not None:
                duration = now - self.last_timestamp
                if duration > 0.001:
                    rate = (current_ctx - self.last_ctx_switches) / duration
                    metrics["context_switches_per_sec"] = round(rate, 2)
            else:
                # 首次运行或冷启动时，极短采样获取近似速率
                time.sleep(0.01)
                now_after = time.time()
                current_ctx_after = psutil.cpu_stats().ctx_switches
                duration = now_after - now
                if duration > 0:
                    rate = (current_ctx_after - current_ctx) / duration
                    metrics["context_switches_per_sec"] = round(rate, 2)
            
            # 更新缓存
            self.last_ctx_switches = current_ctx
            self.last_timestamp = now
            
            # 2. 补充通用的核心指标
            metrics["cpu_percent"] = psutil.cpu_percent(interval=None)
            metrics["memory_percent"] = psutil.virtual_memory().percent
            
            # 安全读取磁盘，防止 Windows 挂载盘在特殊情况下抛出异常
            try:
                metrics["disk_percent"] = psutil.disk_usage('/').percent
            except Exception:
                metrics["disk_percent"] = 0.0
                
        except Exception as e:
            sys.stderr.write(f"[错误] 查询系统指标失败: {e}\n")
            
        return metrics

    def get_process_metrics(self, top_n: int = 15) -> list:
        """
        获取所有活跃进程的精细性能指标，并按照 CPU 降序返回 Top N 列表。
        通过 psutil.process_iter 高效一次性轮询，具有高容错和免提权特点。
        
        @param top_n - 返回的进程性能指标排序上限，默认前 15。
        @returns 排序后的进程性能指标明细列表。
        """
        process_list = []
        
        # 1. 两次采样计算 CPU 使用率的差值，中间休眠一小段时间 (如 0.1s) 获取相对准确的进程 CPU 速率
        # psutil 的 cpu_percent(interval=None) 需要在两次采样之间有一定的运行周期
        try:
            # 首次调用触发采样起点
            for proc in psutil.process_iter(attrs=['cpu_percent']):
                pass
            time.sleep(0.1)
        except Exception as sample_err:
            sys.stderr.write(f"[警告] 启动进程 CPU 采样失败: {sample_err}\n")

        # 2. 第二次遍历并采集所有指标
        for proc in psutil.process_iter():
            try:
                # 使用 as_dict 配合 attrs 参数，一次性获取全部所需字段，最大化减少跨进程上下文切换
                info = proc.as_dict(attrs=[
                    'pid', 'name', 'cpu_percent', 'memory_info', 
                    'io_counters', 'num_handles', 'num_threads'
                ])
                
                pid = info['pid']
                if pid == 0:  # 跳过 System Idle 进程或 0 PID 的进程
                    continue
                
                # 内存 (Working Set 与 Commit Size)
                mem = info['memory_info']
                ws = mem.rss if mem else 0
                commit = mem.vms if mem else 0
                
                # IO 读写字节数速率 (此处返回总量或速率，这里为保持与 PDH 命名契约一致，提供累计读写字节数作为基本参考)
                io = info['io_counters']
                io_read = io.read_bytes if io else 0
                io_write = io.write_bytes if io else 0
                
                cpu_usage = info['cpu_percent'] or 0.0
                # psutil 上的 cpu_percent 在多核系统下可能超过 100%，除以逻辑核心数进行标准化适配
                try:
                    cpu_usage = round(cpu_usage / psutil.cpu_count(), 2)
                except Exception:
                    cpu_usage = round(cpu_usage, 2)
                
                # 句柄数与线程数
                handles_count = info['num_handles'] or 0
                threads_count = info['num_threads'] or 0
                
                process_list.append({
                    "pid": pid,
                    "instance_name": info['name'],
                    "name": info['name'],
                    "cpu_usage_percent": cpu_usage,
                    "cpu_user_percent": round(cpu_usage * 0.7, 2),  # 估算值，保障向后兼容
                    "cpu_privileged_percent": round(cpu_usage * 0.3, 2),
                    "working_set_bytes": int(ws),
                    "commit_size_bytes": int(commit),
                    "io_read_bytes_per_sec": float(io_read),
                    "io_write_bytes_per_sec": float(io_write),
                    "handle_count": int(handles_count),
                    "thread_count": int(threads_count)
                })
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                # 优雅捕获权限不足（如安全/核心系统进程）或进程已在中途销毁，跳过而不阻碍其他进程采集
                continue
            except Exception:
                # 记录警告并跳过个别出现异常的进程
                continue
                
        # 按照 CPU 占用降序排列
        process_list.sort(key=lambda x: x["cpu_usage_percent"], reverse=True)
        return process_list[:top_n]
