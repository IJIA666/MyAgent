## 背景

IJIA Agent 缺乏精细分析 Windows 系统运行状况与带宽消耗的底层能力。我们需要开发一个专门运行于 Windows 环境下的高性能监控服务端，暴露出对应的 MCP 工具供 Agent 消费。此服务端需以 Python 独立进程启动，并通过 Standard I/O (Stdio) 实现与 Node.js 客户端的 MCP 协议通信。

## 目标与非目标

**目标:**
1. 实现 Windows 平台下进程级网络收发速率（上传/下载，单位为 Bytes/sec）的精细统计，精度达到微秒级。
2. 实现系统性能计数器指标的精细收集（包括物理内存占用、虚拟内存提交、页面错误率、非分页池大小、句柄数、CPU 核心态/用户态时间以及磁盘 I/O 排队长度等）。
3. 建立零污染的 Python 执行环境，利用 `uv` 极速安装并拉起包含 `pyetwkit`、`psutil` 和 `mcp` 等依赖的运行沙箱。
4. 提供基于 `ctypes` 的管理员权限检测与 Fail-Fast 机制，如果权限不足则友好报错，引导用户以管理员身份运行 Agent 客户端。
5. 在内存中建立 PID 到进程名称的轻量级 LRU 缓存，结合 `Microsoft-Windows-Kernel-Process` 实时捕获进程的创建和销毁，精准跟踪瞬发进程。
6. 在服务端实现 3 秒到 5 秒滑动窗口的时间窗口数据聚合（Time-window Aggregation），每次调用仅返回速率前 N 的统计数据，杜绝流式事件导致的 Token 爆炸。

**非目标:**
1. 不开发独立的可视化客户端 GUI 界面（由 Node.js Agent 客户端或外部报告处理界面渲染）。
2. 不进行跨平台适配，本 MCP Server **仅支持 Windows 平台**。
3. 不使用抓包驱动（如 Npcap / WinPcap），坚决避免在用户操作系统上强行安装网卡拦截驱动。
4. 不在后台进行长期的持久化监控数据存储，所有聚合均在内存中实时计算。

## 架构决策

1. **采用 Stdio 交互的 Python MCP Server**：
   - **Why**：Model Context Protocol (MCP) 目前最稳定、低延迟的传输介质就是 Stdio。由 Node.js 进程通过 `spawn` 调起 Python 子进程并利用标准输入输出交换 JSON 数据，免去了 TCP 端口冲突和复杂的握手。
2. **基于 ETW (pyetwkit) 获取网络指标，而不是 `netstat` 轮询**：
   - **Why**：`netstat` 或 `Get-NetTCPConnection` 只能获取连接状态，没有任何网络流量和字节量的统计；而 ETW (Event Tracing for Windows) 直接通过内核级别的 TCPIP 订阅，能够捕获微秒级的每一次 packet 数据收发，完美对应到具体 PID，这是 Windows 下最高效、无特异性驱动要求的网络监控手段。
3. **基于 Windows 性能计数器 (Performance Counters) 获取系统指标**：
   - **Why**：Windows 系统性能计数器（Performance Counters）是由操作系统直接暴露的高精度遥测接口，可以无延迟获取线程数、非分页池、IO 队列等极精细指标，比单纯使用 `psutil` 更为底层和丰富。
4. **内存 LRU 缓存进程信息与进程生命周期 ETW 订阅**：
   - **Why**：对于瞬发脚本，其运行极短，直接轮询会由于 PID 消失而查不到进程名。通过订阅 `Microsoft-Windows-Kernel-Process` ETW 事件，能够在进程被创建的第一时间将 PID -> 进程名称的关系载入内存，且当进程被销毁时将其归档或延时清理。

## 风险与权衡

1. 风险：ETW 必须管理员特权，且 UAC 提权会导致 Stdio 管道脱离
   - 权衡与缓解：如果试图在非特权进程中通过 `ShellExecuteW` 提权，拉起的特权子进程会因为父进程句柄失效而失去 Stdio 管道继承，导致 MCP 服务失效。因此本方案舍弃自动提权，采取 Fail-Fast 策略：启动时检测 `IsUserAnAdmin()`，若为 False，立即向 `sys.stderr` 打印错误并返回非零错误码退出。由 Node.js Agent 客户端捕获该退出状态，并提示用户以管理员权限启动命令行终端。
2. **风险：高频网络包事件导致 Python 侧 CPU 占用过高**
   - **权衡与缓解**：ETW 流量捕获采用 `pyetwkit`（由 Rust 编写核心，多线程流式消费），在 Python 侧通过独立线程高频写入内存哈希表并滑动聚合。主 Stdio 线程仅异步读取该聚合数据。对 LLM 仅返回 Top 5/10 聚合后的数据，保护 Agent 端。
3. **风险：同名进程的计数器映射混乱**
   - **权衡与缓解**：Windows Performance Counters 会使用类似 `chrome`、`chrome#1`、`chrome#2` 的编号，在 Python 端需额外维护一个映射表，通过读取 `\Process(*)\ID Process` 计数器，获取每个带编号实例的真实 PID，从而将性能指标精准关联到对应的 PID。
