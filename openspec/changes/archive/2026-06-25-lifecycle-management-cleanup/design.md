## 背景

系统在运行期间，通过 `McpToolManager` 派生多个外部 MCP 子进程，并通过 Playwright 派生 Chromium 进程。目前，退出信号的捕捉分散在 `index.ts`、`mcp-client.ts` 与 `browser-action.ts` 三处。由于主入口 `index.ts` 在捕获 `SIGINT` 时会执行同步 `process.exit(0)`，导致 Node.js 进程瞬间结束，而各子模块的异步清理 Promise 还没来得及运行完毕便被截断，从而在 Windows 或 Unix 后台遗留大量僵尸进程。同时，Playwright Persistent Context 模式下没有暴露进程 PID 的 API，导致原有的 `exit` 事件同步兜底强杀逻辑对浏览器进程完全无效。

## 目标与非目标

**目标:**
- 实现统一的全局生命周期协调器（`LifecycleManager`），支持组件按需注册异步清理回调。
- 保证在捕获到 `SIGINT`/`SIGTERM` 时，先完整执行异步优雅清理流程，最后才执行 `process.exit()` 终止进程。
- 引入全局 5 秒的硬超时与单个组件 2 秒的 Promise 超时双层熔断保护，防止组件卡死导致进程无法退出。
- 对 Playwright 浏览器进程提供基于物理 Profile 特征（`userDataDir`）命令行匹配的 PID 检索与级联进程树强杀兜底机制，解决浏览器僵尸进程问题。
- 确保整个重构方案完全符合六边形架构，`LifecycleManager` 不向 Driven Adapters 产生反向依赖。

**非目标:**
- 坚决不引入外部重量级的进程管理器（如 PM2 等第三方守护进程工具）。
- 不把命令物理沙箱机制（`terminal-guard.ts`）或 RAG 上下文压缩服务引入本次生命周期的重构。
- 坚决不使用任何会强制打断普通用户命令流程的交互式二次确认。

## 架构决策

1. **统一注册回调模式 (Cleanup Registry)**：
   设计 `LifecycleManager` 为纯事件/回调注册器。`index.ts` 负责初始化 LifecycleManager，各组件（MCP、Playwright、Logger 等）在各自的 Adapter 初始化完成后，通过 `LifecycleManager.register('name', cleanupFn)` 将自身的关闭逻辑注册到管理器中。该决策有效解耦了核心生命周期模块与具体驱动适配器。
2. **全局统一捕获退出信号 (Trapping Signals in Entrypoint)**：
   移除各组件各自对 `process.on('SIGINT')`、`process.on('SIGTERM')` 等信号的重复注册。仅在 `index.ts` 入口层统一注册信号处理，在捕获中断后唯一调用 `LifecycleManager.shutdown(exitCode)` 发起清理，彻底杜绝多点竞态抢跑导致的提前强退。
3. **针对 Playwright 持续上下文的原生特征强杀 (Heuristic PID Resolution via CLI)**：
   Playwright 在使用 `launchPersistentContext` 启动浏览器时，其 `BrowserContext` 不暴露 PID，导致在优雅关闭卡死时无法强杀。为此决策在 `BrowserSession` 中封装原生进程查找方法。在优雅 `closeTenant` 超时或失败后，降级执行 OS 原生进程列表查询：
   - **Windows**：`wmic process where "name='chrome.exe' or name='chromium.exe'" get processid,commandline`
   - **Unix**：`ps -ef`
   通过检查命令行中是否含有 `userDataDir` 标识，过滤出特定的 PID，随后利用系统强杀命令（`taskkill` 或 `kill -9`）实施级联进程树物理清理。

## 风险与权衡

- **[风险点一]**：在 Windows 上，由于权限限制，`wmic` 命令可能在特定普通用户模式下执行受阻。
  - **缓解策略**：在执行 `wmic` 原生命令前包裹 `try-catch` 进行静默降级处理，当其失败时，继续尝试常规的优雅调用，并给出诊断日志，同时保留 Node.js 原生的 `exit` 同步流释放兜底。
- **[风险点二]**：在异步执行 `Promise.race` 熔断后，被抛弃的组件清理函数依然在后台以微任务执行，如果此时它发生了 unhandled promise rejection，可能引发全局崩溃。
  - **缓解策略**：在 `LifecycleManager` 中将所有的清理 Promise 用一个 `try-catch-all` 的包装器进行安全围挡，确保即使超时抛弃，后台运行的微任务也不会因未捕获异常瘫痪整个退出程序。
