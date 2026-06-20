import sys
import atexit
from mcp.server.fastmcp import FastMCP
from etw_monitor import EtwMonitor
from system_monitor import SystemMonitor

# 创建 FastMCP 实例
mcp = FastMCP("SystemMonitoringServer")

# 全局实例化监控器
etw_monitor = EtwMonitor()
system_monitor = SystemMonitor()

def start_monitors():
    """
    启动系统和流量监控器。
    """
    try:
        etw_monitor.start()
        sys.stderr.write("[Info] ETW and System Monitors started.\n")
    except Exception as e:
        sys.stderr.write(f"[Fatal] Failed to start monitors: {e}\n")
        sys.exit(1)

def stop_monitors():
    """
    优雅停止监控器，释放 Windows ETW 会话资源。
    """
    sys.stderr.write("[Info] Stopping monitors...\n")
    etw_monitor.stop()

# 注册进程退出清理钩子
atexit.register(stop_monitors)

@mcp.tool()
def get_network_traffic(window_seconds: int = 5, top_n: int = 10) -> list:
    """
    获取 Windows 过去 N 秒内进程级网络流量带宽统计 Top N 报告。
    
    @param window_seconds - 时间滑动聚合窗口大小（秒），默认 5 秒。
    @param top_n - 返回的排名上限数，默认前 10。
    @returns 排序后的流量统计明细列表。
    """
    sys.stderr.write(f"[Info] tool get_network_traffic called: window={window_seconds}, top_n={top_n}\n")
    window_seconds = max(1, min(60, window_seconds))
    top_n = max(1, min(100, top_n))
    return etw_monitor.get_aggregated_traffic(window_seconds=window_seconds, top_n=top_n)

@mcp.tool()
def get_system_resources(top_n: int = 15) -> dict:
    """
    获取 Windows 系统的详细性能指标报告，包含系统整体性能和进程级指标。
    
    @param top_n - 返回的进程性能指标排序上限，默认前 15。
    @returns 包含系统和进程性能指标的字典。
    """
    sys.stderr.write(f"[Info] tool get_system_resources called: top_n={top_n}\n")
    top_n = max(1, min(100, top_n))
    
    system_metrics = system_monitor.get_system_metrics()
    process_metrics = system_monitor.get_process_metrics(top_n=top_n)
    
    return {
        "system": system_metrics,
        "processes": process_metrics
    }
