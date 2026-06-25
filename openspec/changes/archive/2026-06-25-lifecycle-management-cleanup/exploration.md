# 探索主题: 全局集中式生命周期协调与多进程优雅退出机制

## 1. 问题定义
在 IJIA Agent 运行期间，智能体会启动并连接外部 MCP 服务（派生 Node.js 或 Python 子进程树）以及网络浏览器自动化服务（派生 Playwright Chromium 实例）。目前，退出信号的捕获是分散且竞态的，当用户按下 Ctrl+C (`SIGINT`) 时，主进程会同步退出，导致 MCP 与浏览器的异步清理函数无法执行，大量残留子进程在 Windows/Unix 操作系统后台常驻，引发资源泄露。

本探索旨在设计一套**全局集中式生命周期协调器**，统一接管进程级信号（SIGINT, SIGTERM）及异常（uncaughtException, unhandledRejection），并采用**双层熔断防护（全局 Failsafe + 局部超时）**确保所有外部组件及子进程优雅清理后再退出。

## 2. 关键发现与调研结果

- **代码库现状**：
  1. 当前进程在三处独立监听退出信号：`index.ts` 中的 `handleExitSignal`、`mcp-client.ts` 构造函数以及 `browser-action.ts` 中的 `registerExitHandlers`。
  2. `index.ts` 的 `handleExitSignal` 中瞬间执行了 `process.exit(0)`，直接强制终止了 Node.js 主进程事件循环。
  3. `mcp-client.ts` 与 `browser-action.ts` 虽然在 `process.on('exit')` 同步事件中执行了清理动作，但由于 `browser-action.ts` 调用的 `context.close()` 等是**异步 Promise**，在同步 `exit` 回调中根本无法等待其结算便已被强杀，导致 Playwright 进程 100% 残留泄露。
  4. MCP 在 Windows 下虽有 `execSync('taskkill /PID <pid> /T /F')` 作为 exit 兜底，但该机制无法跨平台，且没有优雅退出时间窗口。

- **核实与洞察**：
  根据对 [claude-code](file:///d:/projects/Agent/claude-code-analysis/src/utils/gracefulShutdown.ts) 源码的剖析，成熟的设计具有以下共性特征：
  1. **信号捕获单一点（Single Point of Signal Trapping）**：信号处理器（SIGINT/SIGTERM）仅注册在系统的最外层入口或统一的 Shutdown 模块中，其他 Driven Adapters 严禁直接监听系统级中断信号。
  2. **同步注册与异步结算（Sync Registry & Async Settlement）**：为各个外部适配器提供统一的清理注册总线。各个模块仅需在启动时注册自己的 `cleanup` 异步函数，在退出时由总线串行/并行等待所有的 Promise 结算。
  3. **双重保障熔断器（Dual Failsafe Gates）**：通过 `setTimeout` 注册全局强制退出兜底（通常为 5 秒），且对每个局部的清理 Promise 挂接超时等待（通常为 2 秒），防止由于外部 MCP 网络阻塞或子进程崩溃导致主进程卡死无法退出。

## 3. 方案对比与推荐方向

### 方案 A (硬编码级联式关闭)
在 `index.ts` 中直接硬编码所有的 Driven Adapters 清理步骤：
```typescript
const handleExitSignal = async () => {
  try {
    if (mcpManager) await mcpManager.close();
    await BrowserSession.close();
    await disposeLogger();
  } catch (e) {
    // 容错
  }
  process.exit(0);
};
```
- **优点**：逻辑极为直接，代码修改量最小。
- **缺点**：核心入口层 `index.ts` 直接依赖并耦合了外部适配器的物理实现类（如 `McpToolManager`、`BrowserSession`），违反了端口与适配器（六边形）架构的依赖方向，增加了架构维护成本。

### 方案 B (回调式注册生命周期管理器 - Cleanup Registry) (推荐)
构建独立的生命周期管理服务 `LifecycleManager`，作为核心领域或驱动框架的公共服务，提供统一注册接口：
```typescript
export class LifecycleManager {
  private static cleanups: Array<{ name: string; fn: () => Promise<void> }> = [];
  
  public static register(name: string, cleanupFn: () => Promise<void>) {
    this.cleanups.push({ name, fn: cleanupFn });
  }

  public static async shutdown(exitCode = 0): Promise<void> {
    // 1. 全局熔断 Failsafe
    const timer = setTimeout(() => {
      console.warn('[Failsafe] 清理过程超时，强行退出进程。');
      process.exit(exitCode);
    }, 5000);
    timer.unref();

    // 2. 执行清理队列
    for (const { name, fn } of this.cleanups) {
      try {
        await Promise.race([
          fn(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 2000))
        ]);
      } catch (err) {
        console.error(`[Lifecycle] 模块 ${name} 清理失败或超时:`, err);
      }
    }

    clearTimeout(timer);
    process.exit(exitCode);
  }
}
```
- **优点**：适配器可独立开发、自主注册，入口层与具体适配器逻辑彻底解耦；且提供了精细的全局 5 秒 + 单个模块 2 秒的超时隔离，具备高鲁棒性。

### 方案评估矩阵
| 评估维度 | 方案 A | 方案 B | 结论 |
| :--- | :--- | :--- | :--- |
| **模块解耦性** | 弱 ✗ (入口层重度耦合) | 强 ✓ (依赖倒置，无直接耦合) | 方案 B 占优 |
| **健壮性/超时防御** | 弱 ✗ (任一模块卡死会导致整体卡死) | 强 ✓ (全局与局部超时熔断) | 方案 B 占优 |
| **开发与维护复杂度** | 低 ✓ | 中 ✗ (需设计注册总线) | 方案 A 占优 |

**推荐路径**：采用**方案 B**。我们将构建独立的 `LifecycleManager`，将 MCP 退出、Playwright 退出、Log 刷盘解耦为独立的 Cleanup Hooks 注册。

## 4. 约束、风险与未知项
- **未处理拒绝 (Unhandled Rejection)**：在执行局部超时控制 `Promise.race` 时，超时的 Promise 依然在后台继续执行，若在其超时后发生 reject，可能触发全局的 `unhandledRejection`，需要在 `LifecycleManager` 中将该信号一并拦截，或者确保各模块的清理函数内部有完善的 `try-catch`。
- **进程重入**：当收到多次 `SIGINT` (多次 Ctrl+C) 时，可能导致 `shutdown` 逻辑被重入触发。需要设置 `isShuttingDown` 状态机标志，一旦进入清理，后续所有系统信号一律静默屏蔽。
- **Playwright 持续性上下文进程 PID 检索难点与规避方案**：
  - **痛点**：联网搜索证实，在 Playwright 中通过 `launchPersistentContext` 启动的持久化浏览器，其 `BrowserContext` 在 API 设计上并**不暴露底层的子进程句柄或 PID**。因此无法直接像 MCP 客户端那样通过 `childProcess.pid` 获取其 PID 执行精确强杀。
  - **解决方案**：在优雅 `close` 超时熔断后，降级为使用操作系统原生的进程管理命令行工具，通过匹配命令行参数中包含的租户专属物理 Profile 路径 `userDataDir` 进行特征查找：
    - **Windows 平台**：通过执行原生 `wmic` 命令（例如 `wmic process where "name='chrome.exe' or name='chromium.exe'" get processid,commandline`），解析结果并提取包含指定租户物理路径（`.myagent/browser-session/<tenantId>`）的 `ProcessId`，随后调用 `taskkill /PID <pid> /T /F` 执行强杀。
    - **Unix (macOS/Linux) 平台**：通过执行 `ps -ef` 结合命令行字符串进行正则解析，匹配包含 `userDataDir` 字符串的 `chrome/chromium` 进程，解析出 PID 后执行 `kill -9 <pid>` 级联强杀。

## 5. 否决方案
- **使用 `process.on('exit')` 的同步 `spawnSync / execSync` 方案**：虽然同步命令可以在进程退出事件中被强制执行，但在多租户、多页面 Playwright 场景下，无法使用同步 API 优雅关闭浏览器页面和保存数据，且在 Windows 上无法优雅控制跨进程的资源，故舍弃。
