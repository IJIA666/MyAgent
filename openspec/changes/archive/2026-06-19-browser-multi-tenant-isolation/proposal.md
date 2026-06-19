## 改造原因

当前的智能体（IJIA Agent）已实现了 Playwright 内置浏览器控制与人机风控协作登录。但在多租户、多账号并发执行或多会话共存的实际运行场景下，目前智能体底层会话管理默认使用了同一个固定的本地物理缓存目录 `.myagent/browser-session/`。这会导致：
1. **SingletonLock 锁定冲突**：多账号并发运行时，后启动的浏览器实例会因目录被独占锁定而直接崩溃闪退；
2. **会话状态交叉污染**：不同账号的登录 Cookies 和 LocalStorage 发生相互覆盖和串流污染，无法保障数据安全。

为了支撑智能体在多账号、多会话并发场景下的稳定安全运行，需要为智能体引入浏览器多租户 Profile 物理隔离与动态目录路由管理能力。

## 变更内容

本次变更将在智能体浏览器底座与推理上下文管理中，实现以下核心变动：
1. **多租户 Profile 动态绑定与隔离**：支持在初始化浏览器时，依据当前会话的唯一的租户标识（Tenant ID 或 Session ID），自适应路由并生成独立的本地物理 Profile 缓存路径（如 `.myagent/browser-session/<tenant-id>/`），从物理层面实现不同会话间 Cookies、LocalStorage 和文件锁定文件的彻底隔离。
2. **多租户会话与上下文生命周期同步**：支持并发多会话时，底层能够根据当前调用工具的上下文，路由到正确的 `BrowserContext` 与 `Page`，并支持在特定会话退出时执行定向优雅关闭与特定 Profile 缓存目录的回收。

## 业务能力

### 新增业务能力

- `browser-multi-tenant`: 提供智能体对不同账号/租户并发运行时的浏览器 Profile 缓存进行物理路径动态生成、隔离绑定与生命周期优雅回收的能力，保障多账号会话互不干扰。

### 修改业务能力

无。

## 影响范围

1. **浏览器底座工具层（Action）**：
   - 需重构 `src/action/tools/browser/browser-action.ts` 中的 `BrowserSession` 单例生命周期管理，支持缓存和路由多实例 `BrowserContext`，并根据传入的租户上下文自适应装载隔离物理路径。
2. **会话与调度管理（Brain）**：
   - 重构 `src/brain/context.ts` 的 `SessionContext`，使会话上下文携带明确的租户标识符。
   - 重构 `src/brain/services/ToolDispatcher.ts`，在执行 Native Tool 时自动获取当前会话租户标识并传递给浏览器工具执行层。
