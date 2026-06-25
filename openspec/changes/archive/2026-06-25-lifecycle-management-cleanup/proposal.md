## 改造原因

在 Agent 运行期间，系统会连接外部 MCP 服务（派生 Node/Python 子进程）及 Playwright 浏览器会话。目前，系统中对 `SIGINT` 和 `SIGTERM` 中断信号的捕获是分散在各模块（`index.ts`、`mcp-client.ts`、`browser-action.ts`）竞态执行的。当用户按下 Ctrl+C 时，主入口 `index.ts` 瞬间同步退出了进程，导致各外部组件的异步清理流程（如关闭浏览器上下文、断开 MCP 管道连接）未运行完毕便被截断，从而在 Windows 或 Linux 系统后台遗留大量僵尸进程。因此需要重构系统退出机制，引入全局集中式生命周期协调，以彻底解决资源泄漏与进程堆积问题。

## 变更内容

1. **废除各子模块的竞态信号监听**：移除 MCP 客户端与 Playwright 浏览器组件中各自对系统 `SIGINT/SIGTERM` 信号的独立监听器，将控制权全部上缴给集中生命周期管理器。
2. **引入 LifecycleManager 协调器**：设计并实现统一的 `LifecycleManager`，作为核心生命周期总线，提供统一的回调注册接口 `registerCleanup(name, fn)`，并在系统接收退出信号时串行/并行调度所有清理任务。
3. **实现双层熔断保护机制**：
   - **全局 Failsafe**：在触发退出时设置 5 秒硬超时定时器，防止清理任务卡死导致 CLI 无法退出。
   - **局部 Timeout**：执行单个模块清理回调时挂载 2 秒 `Promise.race` 超时，保护其余模块不受单一阻塞模块的干扰。
4. **强化 Playwright 与 MCP 强杀保护**：
   - 为 Playwright 持久化浏览器引入基于 OS 原生命令行（Windows `wmic`，Unix `ps`）匹配 `userDataDir` 特征的 PID 检索与级联进程树强杀机制。
   - 为 MCP 客户端保留并优化跨平台/跨进程树强杀的生命周期关闭保障。

## 业务能力

### 新增业务能力
- `lifecycle-management`: 提供全局统一的系统信号捕获、多组件异步清理编排、跨平台浏览器与 MCP 孙进程树级联强杀，以及防卡死的双层退出熔断防护能力。

### 修改业务能力
<!-- 本次不涉及已有业务能力的需求变更，故留空 -->

## 影响范围

* **受影响代码**：`src/index.ts`（主入口）、`src/adapters/tools/mcp-client.ts`（MCP 管理）、`src/adapters/tools/tools/browser/browser-action.ts`（浏览器生命周期管理）。
* **依赖引入**：无第三方依赖引入，纯采用 Node.js 内置的核心 `child_process`、系统命令以及 Promise 调度机制。
* **开发规格影响**：将使本项目的 Driven Adapters 遵循松耦合的回调式生命周期机制，对六边形架构的依赖流动提供进一步净化。
