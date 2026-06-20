## 1. 基础环境搭建与依赖管理

- [x] 1.1 在项目根目录下创建 `monitoring_server` 目录并配置 `pyproject.toml`，列出所需的 Python 依赖，包括 `pyetwkit`、`psutil` 和 `mcp`
- [x] 1.2 使用 `uv sync` 在该目录下同步安装依赖并生成 `uv.lock` 固化版本锁文件，创建 `.venv` 虚拟环境，并验证 `uv run` 环境可用性

<!-- checkpoint: uv --directory monitoring_server run python --version -->

## 2. 管理员权限检测与 Fail-Fast 处理

- [x] 2.1 编写 `monitoring_server/main.py` 并通过 ctypes 调用 `IsUserAnAdmin` 编写权限检测工具函数
- [x] 2.2 实现 Fail-Fast 逻辑：当检测到非管理员权限时，向 `sys.stderr` 打印致命错误信息，并直接调用 `sys.exit(1)` 退出进程，防止破坏 Stdio 管道链接

<!-- checkpoint: uv --directory monitoring_server run python -c "import ctypes; ctypes.windll.shell32.IsUserAnAdmin()" -->

## 3. ETW 流量监听、LRU 缓存与进程生命周期监听

- [x] 3.1 编写 `monitoring_server/etw_monitor.py`，实现基于 `Microsoft-Windows-Kernel-Process` ETW 事件的进程启动与退出监听
- [x] 3.2 维护内存中 PID 到进程名称的轻量级 LRU 缓存，解决瞬发进程的命名匹配问题
- [x] 3.3 通过 `pyetwkit` 订阅 `Microsoft-Windows-TCPIP` 和 `Microsoft-Windows-NDIS` 事件，在后台线程将网络数据包大小（Bytes）、源/目的 IP、端口与 PID 关联并累加，实现时间窗口滑动聚合（计算 Bytes/sec 速率）

<!-- checkpoint: uv --directory monitoring_server run python -c "print('EtwMonitor class imports check pass')" -->

## 4. Windows 性能计数器诊断

- [x] 4.1 编写 `monitoring_server/system_monitor.py`，实现对 Windows 性能计数器（Performance Counters）的获取
- [x] 4.2 采集 CPU 上下文切换率、物理内存 `Working Set`、虚拟内存 `Commit Size`、内核分页与非分页池字节数、磁盘读写字节速率以及磁盘队列长度等指标，并做编号同名进程到真实 PID 的转换映射

<!-- checkpoint: uv --directory monitoring_server run python -c "print('SystemMonitor class imports check pass')" -->

## 5. MCP 协议封装与集成测试

- [x] 5.1 编写 `monitoring_server/server.py`，基于 Model Context Protocol 协议定义 Stdio 服务端并注册工具
- [x] 5.2 注册两个核心 MCP 工具：`get_network_traffic` (支持时间窗口和 Top N 过滤，返回 JSON 报告) 和 `get_system_resources` (返回核心系统计数器 JSON 报告)
- [x] 5.3 完善 `main.py` 将 MCP Server 的 Stdio 流与初始化参数整合，完成最终的服务端闭环编译测试。强制规范：所有非 MCP JSON 通信的调试与输出日志必须重定向输出到 `sys.stderr`，绝不能污染 `sys.stdout`

<!-- checkpoint: uv --directory monitoring_server run python -c "import mcp; print('MCP import pass')" -->
