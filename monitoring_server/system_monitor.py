import sys
import time
import win32pdh

class SystemMonitor:
    """
    负责获取 Windows 高精度性能计数器。
    实现同名进程 (如 chrome#1) 到真实 PID 的自动映射。
    """
    def __init__(self):
        pass

    def get_system_metrics(self) -> dict:
        """
        获取系统整体的性能计数器指标。
        包括 CPU 上下文切换、页面错误、内核池、磁盘队列等。
        """
        metrics = {}
        query = None
        try:
            query = win32pdh.OpenQuery()
            
            # 定义需要监控的系统计数器路径
            paths = {
                "context_switches_per_sec": r"\System\Context Switches/sec",
                "page_faults_per_sec": r"\Memory\Page Faults/sec",
                "pool_nonpaged_bytes": r"\Memory\Pool Nonpaged Bytes",
                "pool_paged_bytes": r"\Memory\Pool Paged Bytes",
                "disk_queue_length": r"\PhysicalDisk(_Total)\Avg. Disk Queue Length",
            }
            
            handles = {}
            for name, path in paths.items():
                try:
                    handles[name] = win32pdh.AddCounter(query, path)
                except Exception as e:
                    sys.stderr.write(f"[Warning] Failed to add system counter '{path}': {e}\n")
                    
            # 性能计数器必须采样两次以获取有意义的每秒速率值
            win32pdh.CollectQueryData(query)
            time.sleep(0.5)  # 等待采样间隔
            win32pdh.CollectQueryData(query)
            
            for name, handle in handles.items():
                try:
                    _, val = win32pdh.GetFormattedCounterValue(handle, win32pdh.PDH_FMT_DOUBLE)
                    metrics[name] = round(val, 2)
                except Exception:
                    metrics[name] = 0.0
                    
        except Exception as e:
            sys.stderr.write(f"[Error] Failed to query system metrics: {e}\n")
        finally:
            if query:
                win32pdh.CloseQuery(query)
                
        return metrics

    def get_process_metrics(self, top_n: int = 15) -> list:
        """
        获取所有活跃进程的精细性能指标，并按照 CPU 降序返回 Top N 列表。
        通过 \\Process(*)\\ID Process 解析同名进程名到真实 PID 的关联。
        """
        process_list = []
        query = None
        try:
            query = win32pdh.OpenQuery()
            
            # 1. 展开所有的 Process 实例名称
            _, instances = win32pdh.EnumObjectItems(None, None, "Process", win32pdh.PERF_DETAIL_WIZARD)
            
            if not instances:
                return []
                
            # 2. 为每个实例添加对应的计数器
            instance_data: dict[str, dict[str, int]] = {}
            for inst in instances:
                if inst in ("_Total", "Idle"):
                    continue
                    
                instance_data[inst] = {}
                # 添加计数器
                instance_data[inst]["pid_h"] = win32pdh.AddCounter(query, f"\\Process({inst})\\ID Process")
                instance_data[inst]["cpu_h"] = win32pdh.AddCounter(query, f"\\Process({inst})\\% Processor Time")
                instance_data[inst]["cpu_user_h"] = win32pdh.AddCounter(query, f"\\Process({inst})\\% User Time")
                instance_data[inst]["cpu_priv_h"] = win32pdh.AddCounter(query, f"\\Process({inst})\\% Privileged Time")
                instance_data[inst]["ws_h"] = win32pdh.AddCounter(query, f"\\Process({inst})\\Working Set")
                instance_data[inst]["commit_h"] = win32pdh.AddCounter(query, f"\\Process({inst})\\Private Bytes")
                instance_data[inst]["io_read_h"] = win32pdh.AddCounter(query, f"\\Process({inst})\\IO Read Bytes/sec")
                instance_data[inst]["io_write_h"] = win32pdh.AddCounter(query, f"\\Process({inst})\\IO Write Bytes/sec")
                instance_data[inst]["handle_h"] = win32pdh.AddCounter(query, f"\\Process({inst})\\Handle Count")
                instance_data[inst]["thread_h"] = win32pdh.AddCounter(query, f"\\Process({inst})\\Thread Count")

            # 3. 采样两次以计算速率
            try:
                win32pdh.CollectQueryData(query)
                time.sleep(0.5)
                win32pdh.CollectQueryData(query)
            except Exception as sample_err:
                sys.stderr.write(f"[Warning] Sample exception: {sample_err}\n")

            # 4. 读取数据并格式化
            for inst, handles in instance_data.items():
                try:
                    _, pid_val = win32pdh.GetFormattedCounterValue(handles["pid_h"], win32pdh.PDH_FMT_LONG)
                    pid = int(pid_val)
                    if pid == 0:
                        continue
                        
                    # CPU
                    _, cpu = win32pdh.GetFormattedCounterValue(handles["cpu_h"], win32pdh.PDH_FMT_DOUBLE)
                    _, cpu_user = win32pdh.GetFormattedCounterValue(handles["cpu_user_h"], win32pdh.PDH_FMT_DOUBLE)
                    _, cpu_priv = win32pdh.GetFormattedCounterValue(handles["cpu_priv_h"], win32pdh.PDH_FMT_DOUBLE)
                    
                    # Memory
                    _, ws = win32pdh.GetFormattedCounterValue(handles["ws_h"], win32pdh.PDH_FMT_LONG)
                    _, commit = win32pdh.GetFormattedCounterValue(handles["commit_h"], win32pdh.PDH_FMT_LONG)
                    
                    # IO
                    _, io_read = win32pdh.GetFormattedCounterValue(handles["io_read_h"], win32pdh.PDH_FMT_DOUBLE)
                    _, io_write = win32pdh.GetFormattedCounterValue(handles["io_write_h"], win32pdh.PDH_FMT_DOUBLE)
                    
                    # Handles/Threads
                    _, handles_count = win32pdh.GetFormattedCounterValue(handles["handle_h"], win32pdh.PDH_FMT_LONG)
                    _, threads_count = win32pdh.GetFormattedCounterValue(handles["thread_h"], win32pdh.PDH_FMT_LONG)
                    
                    clean_name = inst.split("#")[0] + ".exe" if "." not in inst else inst.split("#")[0]
                    
                    process_list.append({
                        "pid": pid,
                        "instance_name": inst,
                        "name": clean_name,
                        "cpu_usage_percent": round(cpu, 2),
                        "cpu_user_percent": round(cpu_user, 2),
                        "cpu_privileged_percent": round(cpu_priv, 2),
                        "working_set_bytes": int(ws),
                        "commit_size_bytes": int(commit),
                        "io_read_bytes_per_sec": round(io_read, 2),
                        "io_write_bytes_per_sec": round(io_write, 2),
                        "handle_count": int(handles_count),
                        "thread_count": int(threads_count)
                    })
                except Exception:
                    continue
                    
        except Exception as e:
            sys.stderr.write(f"[Error] Failed to query process performance: {e}\n")
        finally:
            if query:
                win32pdh.CloseQuery(query)
                
        # 按照 CPU 占用降序排列
        process_list.sort(key=lambda x: x["cpu_usage_percent"], reverse=True)
        return process_list[:top_n]
