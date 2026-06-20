## 1. 系统监控模块（psutil 重构）

- [x] 1.1 重写 `monitoring_server/system_monitor.py`，彻底移除所有 `win32pdh` 计数器调用逻辑。
- [x] 1.2 在 `system_monitor.py` 中实现 `get_system_metrics()`，直接使用 `psutil` 高效采集 CPU 百分比、物理内存百分比、磁盘占用以及网卡总 IO 数据。
- [x] 1.3 在 `system_monitor.py` 中实现 `get_process_metrics(top_n)`，检索活跃进程各项指标。对于系统进程或访问受阻进程，使用 `try...except (psutil.NoSuchProcess, psutil.AccessDenied)` 优雅捕获权限限制并跳过，避免引发崩溃。

<!-- checkpoint: uv run python -c "import sys; sys.path.append('monitoring_server'); from system_monitor import SystemMonitor; sm = SystemMonitor(); print(sm.get_system_metrics()); print(len(sm.get_process_metrics(5)))" -->

## 2. 流量收集子进程开发

- [x] 2.1 新建并编写 `monitoring_server/etw_collector.py` 脚本，负责以管理员权限运行 `pyetwkit` 的网络与进程事件捕获。
- [x] 2.2 在 `etw_collector.py` 中实现流量事件循环，捕获网络发送/接收包，并以单行 JSON 的格式实时打印到标准输出 `sys.stdout`，且必须在每次 print 后调用 `sys.stdout.flush()`。
- [x] 2.3 在 `etw_collector.py` 的 `main` 入口中强制加入 `ctypes.windll.shell32.IsUserAnAdmin()` 管理员特权校验，若为非管理员运行则通过 `sys.stderr` 打印错误并优雅退出。

<!-- checkpoint: uv run python -c "import sys; sys.path.append('monitoring_server'); from etw_monitor import EtwMonitor; em = EtwMonitor(); print('EtwMonitor module parsed successfully')" -->

## 3. 主进程管道管理与 Job Object 绑定

- [x] 3.1 修改 `monitoring_server/etw_monitor.py`，更改为子进程生命周期和 IPC 数据管道的管理类。
- [x] 3.2 在 `etw_monitor.py` 中引入 `win32job` 模块。在启动子进程前，调用 Windows API 创建匿名 Job Object，并为其属性配置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`。
- [x] 3.3 修改 `etw_monitor.py` 的启动流程：使用 `subprocess.Popen` 并显式重定向 `stdin=subprocess.DEVNULL` 以隔离输入，防止管道争抢冲突；启动后立即执行 `win32job.AssignProcessToJobObject` 将其进程句柄（Handle）绑定到 Job Object。
- [x] 3.4 优化 `etw_monitor.py` 数据监听：在 `get_aggregated_traffic()` 中增加对子进程状态 `self.process.poll()` 的动态健康检测，一旦发现子进程非正常退出，自动将 `self.running` 重置为 `False` 并抛出异常，强制触发优雅降级。
- [x] 3.5 重新测试 `monitoring_server/server.py` 在非管理员情况下的启动行为，确保能够捕获子进程迟发性闪退的异常并优雅降级为禁用网络指标。

<!-- checkpoint: uv run python -c "import sys; sys.path.append('monitoring_server'); import win32job; print('win32job successfully integrated')" -->

## 4. 集成与回归验证

- [x] 4.1 清理在探索阶段遗留在 `monitoring_server/` 下的临时基准测试文件 `test_pdh_speed.py` 和 `test_psutil_speed.py`。
- [x] 4.2 检查主项目 Prompt 文件，确保在 Windows 上的指令提示符合原子化规则且使用 Windows 原生命令。
- [x] 4.3 开启 MCP 服务，在普通和管理员权限下分别运行，确认在 10 秒超时内工具稳定响应。
- [x] 4.4 运行项目全套单元测试，保证 MCP 客户端功能正常。
- [x] 4.5 修复 `monitoring_server/etw_collector.py`、`monitoring_server/server.py` 和 `monitoring_server/main.py` 顶部 JSDoc 格式的文件级注释。

<!-- checkpoint: npm run test -->

## 5. 调试修正：交互式输入阻塞与提示符闪现修复

- [x] 5.1 扩展 `src/interface/io/input-listener.ts` 的 `start` 函数，支持可选的 `paused` 参数 `start(paused = false)`，确保传入 `true` 时不调起 `prompt()` 且不唤醒 `inputStream`。
- [x] 5.2 修改 `src/interface/facade.ts`，在 `registerApprovalHandler` 中创建临时 `readline.Interface` 前，显式执行 `process.stdin.resume()`。
- [x] 5.3 修改 `src/interface/facade.ts` 最后的重建监听器调用，更改为 `this.listener.start(true)`，保证生成推理结束前输入监听器处于挂起状态。

<!-- checkpoint: npm run test -->

## 6. 调试修正：僵尸进程与文件锁死修复

- [x] 6.1 在 `monitoring_server/main.py` 中引入 `parent_watchdog` 守护线程，基于 `psutil` 在父进程退出或不可用时，执行 `os._exit(0)` 进行主进程自毁。
- [x] 6.2 在 `monitoring_server/etw_collector.py` 中引入类似的 `parent_watchdog` 守护线程，同样在监控主进程异常退出的情况下进行子进程自毁，并彻底释放所有相关的日志写入句柄。

<!-- checkpoint: uv run python -c "import sys; sys.path.append('monitoring_server'); import psutil; print('psutil is working')" -->

## 7. 调试修正：ETW 会话类型错误导致网络事件属性为空

- [x] 7.1 重写 `monitoring_server/etw_collector.py` 的 ETW 会话初始化逻辑，将原先的 `EtwSession` + `NetworkProvider`/`KernelProvider` 三层提供程序替换为 `KernelSession` + `KernelFlags.NETWORK_TCPIP`（legacy NT Kernel Logger），确保 TcpIp 事件的 `size` 属性能被 Rust 层正确解析。
- [x] 7.2 移除 `etw_collector.py` 中多处已确认无实际作用的冗余调试日志逻辑（所有写入 `etw_raw_events.log` 的代码块以及重复的 `import os`），保持代码整洁。
- [x] 7.3 以管理员权限运行 `etw_collector.py`，验证 stdout 管道能正确输出包含流量数据的 JSON 行。

<!-- checkpoint: 以管理员权限启动 etw_collector.py，确认 stdout 有 JSON 输出 -->

## 8. 调试修正：MCP 客户端退出流程未关闭连接导致僵尸进程

- [x] 8.1 修改 `src/brain/session.ts` 的 `close()` 方法，增加 `await this.mcpManager?.close()` 调用，确保退出时显式关闭 MCP 连接和子进程。
- [x] 8.2 增强 `src/action/mcp-client.ts` 的 `cleanupHandler`，在 `exit` 事件回调中使用同步方式直接终止子进程，避免异步 Promise 在 `exit` 事件中被丢弃。
- [x] 8.3 运行 `npm run test` 确保所有测试通过。

<!-- checkpoint: npm run test -->

## 9. 质检修复：ESLint 违规与代码坏味道

- [x] 9.1 修复 `src/action/mcp-client.ts:L40` 的 `require('node:child_process')` 违反 `@typescript-eslint/no-require-imports` 规则，改为在文件顶部使用 `import { execSync } from 'node:child_process'` 静态导入，在 `syncExitHandler` 中直接引用。
- [x] 9.2 修复 `monitoring_server/etw_collector.py:L174` 的步骤编号注释错误（与 L167 同为"2."），应改为"3."。

