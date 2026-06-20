## 背景

现有的系统性能监控与流量监控服务（`windows-monitoring`）在被 IJIA Agent 客户端调用时发生严重超时（`Request timed out`）。
根本原因在于：
1. 网络流量监听模块（`EtwMonitor`）依赖的 `pyetwkit` 库在后台线程中通过阻塞的 `session.next_event_timeout` 等待网络事件。因 Rust 扩展层未释放 GIL 锁，导致 Python 解释器在没有频繁网络包时被彻底挂起，主 FastMCP 协议服务无法响应 stdio 的命令请求。
2. 进程性能检索模块（`SystemMonitor`）每次轮询时都对系统中所有活跃进程（通常为 300+ 个）重新执行数十个 `win32pdh` 计数器句柄的添加、读取和关闭动作。庞大的系统级 API 轮询开销高达数秒乃至数十秒，远远超出了 MCP 客户端 10 秒超时门槛。
3. 沙箱原子校验极其严厉，拦截了所有包含 `|`、`>`、`;` 等符号的命令；且助手经常出现操作系统幻觉，尝试在 Windows 环境下执行 Linux 特有的命令（如 `top`、`ifconfig`）。

本设计致力于引入多进程解耦方案，并用 `psutil` 全面重写性能采集，以解决上述高耗时与锁死问题。

## 目标与非目标

**目标:**
1. **GIL 锁完全规避**：将基于 `pyetwkit` 的 ETW 流量采集功能剥离至独立的子进程 `etw_collector.py` 运行。主 MCP 服务进程与子进程各拥有独立的解释器和 GIL 锁，消除事件等待引起的 GIL 锁死挂起。
2. **高速性能检索**：使用基于 C 优化的高效 `psutil` 库替代 `win32pdh` 采集逻辑，将系统指标获取耗时控制在 10 毫秒以内，进程级 Top N 指标检索时间（含 CPU 采样）控制在 600 毫秒以内。
3. **子进程绝对安全清理**：在 Windows 平台上为子进程引入 Windows Job Object 作业对象限制，配置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`。确保在主进程崩溃或强杀时，内核自动清理关联的流量收集子进程，彻底消除残留。
4. **容错与优雅降级**：若 Agent 未以管理员运行导致子进程启动 ETW 失败，服务必须捕获子进程的退出状态，降级关闭 `get_network_traffic` 接口并提供友好错误提示，而不影响基于 `psutil` 的系统资源监控（`get_system_resources`）功能正常工作。
5. **沙箱命令优化**：修正提示词配置，让助手在 Windows 上仅会提议单一原子化的 Windows 原生命令。

**非目标:**
1. 不更换底层的 ETW 捕获库（继续使用 `pyetwkit`，但在子进程中运行）。
2. 不更改 Node.js 客户端的协议格式或大模型调用接口契约，维持向后兼容。
3. 不增加其他硬件监控指标（如 GPU、温度等），仅针对现有的系统与网络流量指标做高可用优化。

## 架构决策

1. **子进程拆分与管道 IPC 设计**：
   - 拆分出独立的脚本 `monitoring_server/etw_collector.py`。该脚本负责加载 `pyetwkit` 并启动 `KernelSession` 进行流量监听。
   - 主监控服务进程 `server.py` 在初始化时使用 `subprocess.Popen` 启动子进程：
     ```python
     # 注入 PYTHONUNBUFFERED 以强行冲刷缓冲区
     env = os.environ.copy()
     env["PYTHONUNBUFFERED"] = "1"
     self.process = subprocess.Popen(
         [sys.executable, "etw_collector.py"],
         stdout=subprocess.PIPE,
         stderr=subprocess.PIPE,
         text=True,
         env=env
     )
     ```
   - 子进程在每次监听到网络事件并完成汇总后，将流量数据以单行 JSON 的格式打印至 `stdout`，并强制调用 `sys.stdout.flush()`。
   - 主进程开启独立的辅助线程，通过非阻塞读取子进程的 `stdout`，实时累加并更新全局网络流量缓冲数据。

2. **`psutil` 替代 `win32pdh` 实现性能指标高速检索**：
   - 系统整体资源查询（`get_system_metrics`）：直接读取 `psutil.cpu_percent`、`psutil.virtual_memory`、`psutil.disk_usage` 以及 `psutil.net_io_counters`。
   - 进程性能数据查询（`get_process_metrics`）：调用 `psutil.process_iter` 一次性获取所有活跃进程的 `['pid', 'name', 'cpu_percent', 'memory_info', 'io_counters', 'num_threads', 'num_handles']` 信息。
   - 针对非特权用户运行的情况，使用 `try...except (psutil.NoSuchProcess, psutil.AccessDenied)` 优雅捕获权限限制，跳过系统内核进程，对普通用户进程提供完整的指标采集服务。

3. **Windows Job Object 强生命周期绑定**：
   - 主监控服务 `server.py` 启动子进程前，调用 Windows 内核 API 创建匿名 Job Object，并压入关联关系：
     ```python
     import win32job
     import win32handle
     
     # 创建 Job Object
     self.h_job = win32job.CreateJobObject(None, "")
     
     # 配置限制：在主进程 Job 句柄关闭时强杀所有 Job 内的子进程
     info = win32job.QueryInformationJobObject(self.h_job, win32job.JobObjectExtendedLimitInformation)
     info['BasicLimitInformation']['LimitFlags'] |= win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
     win32job.SetInformationJobObject(self.h_job, win32job.JobObjectExtendedLimitInformation, info)
     
     # 在 subprocess.Popen 启动子进程后，立即绑定
     win32job.AssignProcessToJobObject(self.h_job, self.process._handle)
     ```
   - 如此一来，一旦主 Python 进程或 Node.js 客户端主进程退出/崩溃，操作系统内核将自动、同步地将 `etw_collector.py` 强制终止。

4. **[调试修正] 管道 stdin 隔离与动态健康度检查**：
   - **输入流冲突隔离**：在启动子进程的 `subprocess.Popen` 中必须显式重定向 `stdin=subprocess.DEVNULL`，彻底切断子进程继承父进程 stdin 导致的管道读取争抢，防止主控制台输入卡死。
   - **动态死亡检验与降级触发**：由于 Windows 上 Python 初始化及导包可能耗时超过 0.5s 预检期，我们必须把静态检测升级为动态健康检验。在 `get_aggregated_traffic()` 获取流量的入口处，若检测到子进程已经死亡 (`self.process.poll() is not None`)，则自动重置 `self.running = False` 并抛出异常，触发主服务 `server.py` 的优雅退化降级逻辑。


## 风险与权衡

- **[无特权运行权限限制]** -> `etw_collector.py` 监听 ETW 需要管理员特权。如果在普通权限运行的终端中启动，子进程启动会立即崩溃。
  - *缓解策略*：子进程在 `main` 入口校验 `ctypes.windll.shell32.IsUserAnAdmin()`。若不是管理员，向 `stderr` 打印清晰原因并退出。主进程通过辅助线程读取子进程的 `stderr`，检测到提权异常时，主动降级将 `get_network_traffic` 工具设为不可用（或返回友好错误说明），但仍保障不需要特权的 `get_system_resources` 正常提供系统资源监控能力。
- **[管道读取阻塞风险]** -> 子进程向主进程传送 JSON 数据时，主进程若用同步的 `readline()` 读取可能会被阻塞挂起。
  - *缓解策略*：主进程中使用独立的守护线程专职负责 `readline`。主进程读取子进程时，数据解析全在守护线程中完成，并写入带有互斥锁的数据缓存结构中；主 FastMCP 服务读取时直接从缓存读取，保证 Stdio 协议的即时响应。

5. **[调试修正] 审批卡关交互卡死与提示符闪现修复**：
   - **交互流 Stdin 静默暂停唤醒**：在 `CliFacade` 的 `registerApprovalHandler` 回调中，针对由于旧 `readline` 关闭所致的 `process.stdin` 暂停问题，在创建新的临时 `readline` 实例前，显式调用 `process.stdin.resume()` 将输入流唤醒，保证交互界面的输入可立刻被捕获。
   - **监听器重建延迟激活**：对 `InputListener.start(paused)` 进行扩展，支持可选的 `paused` 参数。在安全拦截审批的回调收尾重建时执行 `this.listener.start(true)`，使其保持在暂停状态，消除在推理生成中抢占 `stdin` 和提前闪烁 `用户 [xxx] >` 提示符的问题。生成完全结束后由 `finally` 中固有的 `resume()` 方法统一唤醒。


## 6. [调试修正] 僵尸进程与文件锁死修复

- **父进程存活看门狗 (Watchdog)**：
  为了解决在 Windows 下客户端（MCP Client）退出强杀父进程 `uv` 后，残留子进程 `python main.py`（主进程）与孙进程 `python etw_collector.py`（ETW 收集器）导致大量僵尸进程并锁定日志文件的问题，在 `main.py` 与 `etw_collector.py` 启动阶段引入基于 `psutil` 的后台守护线程：
  - 该守护线程在进程启动时通过 `os.getppid()` 记录父进程的 PID。
  - 线程每隔 2 秒检测一次该父进程在操作系统中是否依然存在且处于运行状态。
  - 如果检测到父进程已经退出或不可达（例如因为宿主强杀、进程消亡等），则立即调用 `os._exit(0)` 进行快速自毁。
  - 主进程的自毁自动关闭所有打开的句柄，从而触发 Windows `Job Object` 清理机制自动杀死子进程；同时子进程的双重 Watchdog 机制提供额外保险，确保即使 Job Object 失效，子进程也能完成安全自毁并彻底释放文件句柄。

## 7. [调试修正] ETW 会话类型错误导致网络事件属性解析为空

- **根因**：`etw_collector.py` 使用 `pyetwkit.EtwSession`（用户模式 manifest-based 会话）配合 `NetworkProvider.tcpip()`、`NetworkProvider.winsock()`、`KernelProvider.network()` 三个新版提供程序。然而这些新版 provider 发出的事件在 `pyetwkit` 的 Rust 内核中未能正确解析属性——实测日志中所有事件的 `event.properties` 均为空字典 `{}`，完全无法提取 `size` 字段。
- **过滤逻辑与会话类型不匹配**：代码中的事件过滤逻辑（opcode 10/11 + `"size" in props`）是基于旧版 NT Kernel Logger（legacy MOF 格式 `TcpIp_TypeGroup1`）的假设，但实际启动的是新版 manifest-based 会话。
- **修正方案**：将 `etw_collector.py` 中的 ETW 会话从 `EtwSession` + `NetworkProvider`/`KernelProvider` 三层提供程序切换为 `KernelSession` + `KernelFlags.NETWORK_TCPIP`。`KernelSession` 对应的是 legacy NT Kernel Logger，在此模式下 `TcpIp` 事件的属性（包括 `size`）才能被 Rust 层正确解析，opcode 10（Send）/ 11（Recv）的过滤也才是正确的。
- **额外清理**：移除 `etw_collector.py` 中已确认无实际作用的冗余调试日志逻辑（多处写入 `etw_raw_events.log` 的代码块），保持代码整洁。

## 8. [调试修正] MCP 客户端退出流程未关闭连接导致僵尸进程

- **根因一 — `session.close()` 遗漏 MCP 关闭**：`SessionManager.close()`（`src/brain/session.ts:L242-246`）仅执行了 `abort()` 和 `abortSessionTasks()`，但没有调用 `this.mcpManager?.close()` 来触发 MCP 子进程的优雅关闭。用户输入 `exit` 退出时（`facade.ts:L168-171`），`session.close()` 后紧接 `process.exit(0)`，MCP 子进程从未被显式终止。
- **根因二 — `exit` 事件中异步代码不会执行**：`McpToolManager` 构造函数注册的 `process.on('exit', cleanupHandler)` 回调调用了异步的 `this.close()`，但 Node.js 的 `exit` 事件只能执行同步操作——任何 Promise 都会被丢弃，导致 `shutdownConnection()` 永远不会被执行。
- **修正方案**：
  1. 在 `SessionManager.close()` 中增加 `await this.mcpManager?.close()` 调用，确保显式执行优雅关闭。
  2. 对 `McpToolManager` 的 `cleanupHandler` 进行防御性增强：在 `exit` 回调中使用同步方式直接 kill 子进程（通过 `process.kill()` 或等效机制），而非依赖异步 Promise。
  3. 看门狗机制保留作为最后兜底。
