import sys
import ctypes

# 导入 server 里的 FastMCP 实例和初始化钩子
from server import mcp, start_monitors

def is_admin() -> bool:
    """
    使用 Windows API 检测当前进程是否拥有管理员权限。
    
    @returns 若拥有管理员权限，返回 True，否则返回 False。
    """
    try:
        return ctypes.windll.shell32.IsUserAnAdmin() != 0
    except Exception as e:
        sys.stderr.write(f"[Warning] Failed to check admin privilege: {e}\n")
        return False

def main():
    """
    系统监控服务端入口函数。
    负责特权校验（Fail-Fast）并启动 MCP 协议服务端。
    """
    # 强制进行管理员权限检验
    if not is_admin():
        sys.stderr.write("[Fatal] System monitoring server requires Administrator privileges. Please run Agent with administrative elevation.\n")
        sys.exit(1)
        
    sys.stderr.write("[Info] Admin check passed. Starting monitoring server...\n")
    
    # 启动后台监控线程
    start_monitors()
    
    # 启动 MCP Server (Stdio 协议)
    # FastMCP 会接管 sys.stdin / sys.stdout
    try:
        mcp.run("stdio")
    except Exception as e:
        sys.stderr.write(f"[Fatal] FastMCP server crashed: {e}\n")
        sys.exit(1)

if __name__ == "__main__":
    main()
