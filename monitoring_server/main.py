"""
@fileoverview 系统监控服务的启动主入口。
负责触发后台监测子进程引导并启动基于 Stdio 协议的 FastMCP 通信服务。
"""
import sys
import os
import time
import threading
import psutil
from server import mcp, start_monitors

def start_parent_watchdog():
    """
    启动父进程生命周期监听看门狗。
    
    获取当前进程的父进程 PID，在后台启动一个守护线程，
    每隔 2 秒检测父进程存活状态。若父进程退出了，则强制自毁当前进程。
    """
    parent_pid = os.getppid()
    if parent_pid <= 1:
        return

    try:
        parent_proc = psutil.Process(parent_pid)
        parent_create_time = parent_proc.create_time()
    except Exception:
        # 获取父进程实例或启动时间失败，判定父进程已经不在，直接退出
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
            except BaseException:
                os._exit(0)

    # 启动守护线程，确保不阻碍主线程退出
    t = threading.Thread(target=watchdog_loop, daemon=True)
    t.start()

def main():
    """
    系统监控服务端入口函数。
    启动后台监控与 MCP 协议服务端。
    """
    sys.stderr.write("[信息] 正在启动系统监控服务端...\n")
    
    # 启动父进程生命周期监听，防止僵尸进程残留
    start_parent_watchdog()
    
    # 启动后台监控子进程 (内部具有特权预检与优雅降级)
    start_monitors()
    
    # 启动 MCP Server (Stdio 协议)
    # FastMCP 会接管 sys.stdin / sys.stdout
    try:
        mcp.run("stdio")
    except Exception as e:
        sys.stderr.write(f"[致命错误] FastMCP 服务端崩溃: {e}\n")
        sys.exit(1)

if __name__ == "__main__":
    main()
