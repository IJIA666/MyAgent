## 背景

目前，IJIA Agent 具备基于 Playwright 驱动的内置浏览器自动化工具体系，核心的会话与状态控制主要封装在 `src/action/tools/browser/browser-action.ts` 中的 `BrowserSession` 类中。

然而，当前的 `BrowserSession` 采用了静态单例设计模式（持有唯一的 `context` 与 `page` 静态属性），且本地持久化存储路径默认写死为统一的 `.myagent/browser-session`。在智能体面对并发多会话（如多账号并行推理或同一时间执行多个网络控制任务）的场景时，后启动的浏览器实例会因物理目录被 SingletonLock 独占锁定而引发闪退崩溃，同时也存在不同会话的 Cookies 交叉覆盖与状态污染等致命缺陷。为了支撑多租户并发执行，亟需进行底座实例管理的动态隔离设计。

## 目标与非目标

**目标:**
1. **多租户 Map 容器化实例路由**：将原本的静态 Context/Page 单态单例重构为基于多租户 ID（`tenantId`）的 Map 映射容器（如 `private static contextsMap = new Map<string, BrowserContext>()`），实现会话多态下的多实例并发路由与状态隔离。
2. **自适应租户物理隔离目录生成**：在启动持久化浏览器上下文时，基于当前的 `tenantId` 动态合成并装载本地物理隔离目录 `.myagent/browser-session/<tenantId>/`，从物理层隔绝锁定冲突。
3. **租户会话与上下文生命周期同步**：在 `BrowserSession` 中提供 `closeTenant(tenantId, cleanup)` 定向释放接口，支持关闭特定租户的 Page 和 Context，释放 SingletonLock，并允许在关闭时彻底物理擦除该租户的 Profile 缓存。

**非目标:**
1. 本次重构不为智能体 REPL CLI 提供多会话/多租户的多 Tab 终端物理切换界面，多租户隔离机制仅在 Brain 层的 `SessionContext`、`SessionManager` 和 Action 层的 `BrowserSession` 内部隐式打通。

## 架构决策

### 决策 1：基于 Map 映射多路分发的静态 BrowserSession 升级
- **决策理由**：相较于将 `BrowserSession` 重构为普通类并要求各个 Native Tool 单独持有其实例，采用静态 Map 容器（`private static pageMap = new Map<string, Page>()`）的全局单例门面，既能最大限度保留原有代码中 `BrowserSession.getPage()` 的静态简易调用风格，又能快速升级为基于当前会话租户标识的多路并发路由隔离，对原有 8 个 Native Tools 执行层代码的改动和入侵最小。

### 决策 2：租户上下文在 Tool 调用链中的自适应隐式传参
- **决策理由**：为了让 Native Tool 的 `execute` 方法感知当前的租户标识，我们重构 `NativeTool` 接口的第二入参。具体地，`ToolDispatcher` 与 `McpToolManager` 在分发调用 Native Tool 时，从当前大循环的 `SessionContext` 中读取当前的 `tenantId`（默认为 `default`），并通过 `execute(args, sessionContext)` 的第二个参数作为上下文传递给 `BrowserSession.getPage(cdpUrl, tenantId)`。这样做完全不改变 Native Tool 的入参 JSON Schema 声明，对大模型透明，仅在底层调度分发层完成参数桥接。

## 风险与权衡

| 风险点 | 影响 | 缓解策略/决策取舍 |
| :--- | :--- | :--- |
| **多进程 SingletonLock 文件锁定** | 后启动的浏览器实例在启动阶段闪退 | **动态租户目录完全隔离**：通过 `tenantId` 差异路由至不同隔离目录（`.myagent/browser-session/<tenant-id>/`），使各并发实例拥有各自独立的锁文件，互不干扰。 |
| **临时 Profile 撑爆本地磁盘空间** | 大量临时或单次会话运行导致磁盘空间冗余 | **周期性定向清理机制**：在 `BrowserSession` 中提供 `closeTenant(tenantId, cleanup: boolean)` 接口。对于临时的匿名租户或短期运行实例，在会话销毁时自动调用物理删除，回收磁盘空间。 |
| **Node.js 进程意外崩溃或强行终止 (如 Ctrl+C)** | 后台残留无头的 Chrome 僵尸进程及大体积未被清理的临时 Profile 文件夹 | **进程生命周期优雅拦截与资源强退机制**：在 `BrowserSession` 首次装载时，全局监听进程退出与退出信号（如 `process.on('exit')`、`SIGINT`、`SIGTERM`），强行遍历 `contextsMap` 安全释放资源并清理临时目录。 |

