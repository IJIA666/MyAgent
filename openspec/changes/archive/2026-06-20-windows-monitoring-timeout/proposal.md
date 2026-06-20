## 改造原因

在 IJIA Agent 的运行过程中，当用户请求系统性能分析与网络流量监控时，系统当前遇到了以下两个核心痛点，导致功能不可用：
1. **服务调用超时（MCP error -32001）**：
   - 流量监控（ETW）依赖的 `pyetwkit` 库在等待事件的阻塞方法中没有释放 GIL 锁，导致后台监听线程完全独占了 Python 解释器的执行时间片，挂起了负责 stdio 通信和 FastMCP 协议解析的主线程。
   - 性能监控使用 `win32pdh` 接口，在查询进程性能指标时为几百个进程实时创建数千次性能计数器连接。这种高开销的系统级 API 调用耗时数秒甚至十几秒，进一步堆积了延迟，使得 MCP 客户端必然在 10 秒内超时。
2. **终端复合指令执行被拒**：
   - Agent 核心沙箱对终端工具进行了严苛的安全校验，任何包含重定向、管道或分号的复合指令均会被直接阻断。
   - 助手存在操作系统环境幻觉，尝试在 Windows 上执行 macOS/Linux 的 `top`、`ifconfig` 等不支持的命令。

因此，亟需对现有的系统性能监控与流量监控方案进行重构和规格健壮性修复，以消除执行超时与沙箱阻断。

## 变更内容

1. **废弃 PDH 实现，引入 `psutil` 高速采集**：
   - 全面抛弃 `system_monitor.py` 中基于 `win32pdh` 的进程遍历及计数器创建逻辑，改用基于 C 优化的 `psutil` 库。
   - 实现系统整体资源（CPU、Memory、Disk、Net IO）与进程级 TOP N 指标（CPU、内存工作集、虚拟提交、IO 读写、线程、句柄）的高速检索（耗时可降至毫秒级），并解决免特权运行和优雅异常捕获。
2. **多进程架构重构与 GIL 锁规避**：
   - 将 ETW 流量监听从主 MCP 进程中剥离，移入独立的子进程 `etw_collector.py`。
   - 子进程独享自身的 GIL，其在 `next_event_timeout` 中的阻塞与 GIL 独占绝不波及主 MCP 进程。
   - 主子进程间通过 Stdout 管道传递 JSON 格式的流量日志，主进程使用非阻塞或异步读取收集数据，并设置 `PYTHONUNBUFFERED=1` 环境变量与在子进程中主动冲刷缓冲（`sys.stdout.flush()`）。
3. **引入 Windows Job Object 安全回收机制**：
   - 强制将子进程注册关联到主进程创建的 Windows Job Object，并配置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`。确保在主进程发生异常退出、强杀（Force Kill）或蓝屏等极端情况下，操作系统会物理清理残留的子进程，彻底消除僵尸进程。
4. **提示词指令优化**：
   - 优化 Prompt 指示，使助手明确感知 Windows 平台环境，并且在提议终端命令时严格遵循单一原子化的 Windows 原生指令（如 `tasklist` 或 `ipconfig`），不得带有任何管道或重定向。

## 业务能力

### 新增业务能力
- `windows-monitoring-optimization`: 提供 Windows 平台下高性能、免特权系统资源分析，及规避 GIL 锁死与彻底防残留（Job Object）的进程级高可用流量监控能力。

### 修改业务能力
- 无

## 影响范围

* **受影响的组件**：
  * `monitoring_server/system_monitor.py`：完全重写数据检索逻辑。
  * `monitoring_server/etw_monitor.py`：变更为仅供主进程调用的流量数据聚合管理模块。
  * `monitoring_server/server.py`：调整服务启动顺序，改为由主进程创建子进程的架构，并注册 Job Object 绑定。
  * `monitoring_server/etw_collector.py` [NEW]：新增独立的子进程脚本，专职负责以管理员权限跑 ETW 监听并输出 JSON 流量数据。
* **依赖引入**：由于使用了 Windows Job Object 且是 Python 环境，需要确保 `pywin32` 包含对 `win32job` 的原生支持。
