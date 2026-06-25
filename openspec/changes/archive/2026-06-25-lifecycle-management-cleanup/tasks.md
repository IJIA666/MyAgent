## 1. 建立全局生命周期协调器 (LifecycleManager)

- [x] 1.1 新增 `src/core/usecases/LifecycleManager.ts` 类，实现统一生命周期协调器。
- [x] 1.2 在 `LifecycleManager` 中实现 `register(name: string, cleanupFn: () => Promise<void>)` 用于注册异步清理函数。
- [x] 1.3 在 `LifecycleManager` 中实现 `shutdown(exitCode: number)` 核心退出逻辑。
- [x] 1.4 为 `shutdown` 方法配备 5 秒的全局熔断硬超时（Failsafe Timer）。
- [x] 1.5 为 `shutdown` 中每个模块的回调函数配备 2 秒的局部超时隔离（使用 `Promise.race` 包装并在超时后安全吃掉微任务报错以防崩毁）。
- [x] 1.6 在 `LifecycleManager` 中引入 `isShuttingDown` 状态保护机制，防止多信号重复触发。
- [x] 1.7 修改 `src/index.ts` 移除分散的信号处理器（`handleExitSignal`），改为在初始化后通过 `LifecycleManager.register` 挂接日志清理（`disposeLogger`），并在最外层入口执行统一的 `process` 信号监听并对接。

<!-- checkpoint: npx tsc --noEmit -->

## 2. 重构外部 MCP 客户端与 Playwright 优雅清理

- [x] 2.1 修改 `src/adapters/tools/mcp-client.ts` 构造函数，移除其对 `SIGINT` 和 `SIGTERM` 退出信号的独立监听器。
- [x] 2.2 仅保留 `mcp-client.ts` 里的 `process.on('exit')` 的同步强杀 `syncExitHandler` 以防范 Node exit 同步兜底。
- [x] 2.3 在 `src/index.ts` 实例化 `mcpManager` 处，调用 `LifecycleManager.register('mcp-manager', () => mcpManager.close())` 挂载优雅退出。
- [x] 2.4 修改 `src/adapters/tools/tools/browser/browser-action.ts` 及 `BrowserSession` 类，移除其对系统 `SIGINT` 和 `SIGTERM` 信号的竞态监听。
- [x] 2.5 在 `BrowserSession` 中封装在优雅关闭超时后获取 PID 的原生方法：在 Windows 下运行 `wmic process where "name='chrome.exe' or name='chromium.exe'" get processid,commandline`；在 Unix 下运行 `ps -ef`，以匹配租户专属 Profile 缓存路径（`.myagent/browser-session/<tenantId>`）为特征，提取出对应的 `ProcessId`。
- [x] 2.6 在 `BrowserSession` 中实现跨平台的进程树物理强杀（Windows 下调用 `taskkill /PID <pid> /T /F`，Unix 下调用 `kill -9 <pid>`），并在 `BrowserSession.close()` 的优雅熔断降级链中触发调用。
- [x] 2.7 在 `src/index.ts` 组装依赖处，调用 `LifecycleManager.register('browser-session', () => BrowserSession.close())` 挂载优雅退出。

<!-- checkpoint: npm run lint -->

## 3. 测试与验证

- [x] 3.1 运行单元测试，验证重构后系统上下文、配置、会话等基本功能的正确性。
- [x] 3.2 运行集成测试，验证 MCP 外部调用流程和 Playwright 浏览器自动化读写功能未受负面影响。

<!-- checkpoint: npm run test -->
