"""
@fileoverview 监控服务端注册与控制中心。
提供 MCP 协议兼容的工具定义，包含系统资源获取与进程流量排序排行检索，
协调主子进程的开启、退出清理以及在普通特权下的优雅退化降级。
"""
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
    支持优雅退化：若 ETW 模块因特权不足或其它原因启动失败，
    降级报错但不退出程序，以确保普通的系统监控功能依然可用。
    """
    try:
        etw_monitor.start()
        sys.stderr.write("[信息] ETW 和系统监控器已启动。\n")
    except Exception as e:
        sys.stderr.write(f"[警告] 启动 ETW 网络监控失败: {e}\n")
        sys.stderr.write("[警告] 系统资源监控将保持激活状态，但网络流量工具将被禁用。\n")

def stop_monitors():
    """
    优雅停止监控器，释放 Windows ETW 会话及 Job 资源。
    """
    sys.stderr.write("[信息] 正在停止监控器...\n")
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
    sys.stderr.write(f"[信息] 接口 get_network_traffic 被调用: 窗口={window_seconds}秒, 数量={top_n}\n")
    
    # 状态预检与优雅降级提示
    if not etw_monitor.running:
        return [{
            "error": "ETW 流量监控未激活（需要管理员权限）。请以管理员身份运行终端以启用网络工具。"
        }]
        
    window_seconds = max(1, min(60, window_seconds))
    top_n = max(1, min(100, top_n))
    try:
        return etw_monitor.get_aggregated_traffic(window_seconds=window_seconds, top_n=top_n)
    except Exception as e:
        sys.stderr.write(f"[警告] 聚合网络流量失败: {e}\n")
        return [{
            "error": "ETW 流量监控动态异常（需要管理员权限）。请检查权限配置。"
        }]

@mcp.tool()
def get_system_resources(top_n: int = 15) -> dict:
    """
    获取 Windows 系统的详细性能指标报告，包含系统整体性能和进程级指标。
    
    @param top_n - 返回的进程性能指标排序上限，默认前 15。
    @returns 包含系统和进程性能指标的字典。
    """
    sys.stderr.write(f"[信息] 接口 get_system_resources 被调用: 数量={top_n}\n")
    top_n = max(1, min(100, top_n))
    
    system_metrics = system_monitor.get_system_metrics()
    process_metrics = system_monitor.get_process_metrics(top_n=top_n)
    
    return {
        "system": system_metrics,
        "processes": process_metrics
    }
