## 1. 契约接口拆分与内置防御策略归位

- [x] 1.1 物理移动内置防御及状态挂起拦截器：
  - 将 `src/adapters/plugins/TokenWatermarkPlugin.ts` 移动 to `src/core/usecases/TokenWatermarkPlugin.ts`
  - 将 `src/adapters/plugins/JitRulesPlugin.ts` 移动 to `src/core/usecases/JitRulesPlugin.ts`
  - 将 `src/adapters/plugins/HumanApprovalPlugin.ts` 移动 to `src/core/usecases/HumanApprovalPlugin.ts`
  级联修正这三者的内部相对引用，在类级紧邻正上方补全规范的 TSDoc 注释。
- [x] 1.2 物理新建契约接口：
  - `src/ports/driven/ApprovalPort.ts`：声明挂起确权审批方法 `waitApproval`
  - `src/ports/driven/EventNotificationPort.ts`：声明异步通知及事件推送方法 `addNotification`、`emit`
  - `src/ports/driven/ToolRegistryPort.ts`：声明工具获取与调用的驱动接口，包含 `close(): Promise<void>` 生命周期回收契约
- [x] 1.3 物理修改 `src/ports/driven/SessionEventPort.ts`，使其成为仅包含基本会话属性（getSessionId, getTenantId, getWorkMode）的只读属性接口，并在其上新增 `getSecurityAllowlist(): string[]` 白名单声明。
- [x] 1.4 修改 `src/adapters/plugins/index.ts` 的 re-export 导出，彻底清除已移回核心内部的三个插件的物理导出。

<!-- checkpoint: npx tsc --noEmit -->

## 2. 核心层主循环及入口依赖反转（DIP）注入重构

- [x] 2.1 修改 `src/core/usecases/session.ts`（`SessionManager` 类），移除对外部 `adapters/` 层具体类（`ToolRegistry`、`McpToolManager` 等）的所有直接 `import` 引用，使用 `ToolRegistryPort` 契约作为构造函数参数，去除对 `McpToolManager` 的持有与生命周期管理，将其生命周期回收代理给 `ToolRegistryPort.close`。
- [x] 2.2 修改 `src/core/usecases/agent-loop.ts`（`AgentLoop` 类），将构造参数 `toolRegistry` 的签名修改为 `ToolRegistryPort`，清除外部具体类的 `import`。
- [x] 2.3 修改系统物理入口 `src/index.ts`，完成 `ToolRegistry` 的物理 `new` 实例化，然后将其作为 `ToolRegistryPort` 注入 `SessionManager` 的构造参数中。
- [x] 2.4 改造 `SessionContext`（`src/core/domain/context.ts`），实现 `SessionEventPort` 中新增的 `getSecurityAllowlist()` 接口，内部桥接调用核心的 `SecurityService.getInstance().getSecurityAllowlist()`。
- [x] 2.5 修改 `src/adapters/tools/tools/system/terminal.ts` 及其它工具的安全性评估逻辑，令其通过传入的超薄 `ApprovalPort` 及 `EventNotificationPort` 进行用户确权和事件派发；并在 `src/adapters/tools/tools/base.ts` 基类和 `terminal.ts` 中完全去除对核心 `SecurityService.getInstance()` 的 import 及调用，改由调用传入端口的 `sessionContext.getSecurityAllowlist()` 完成安全白名单匹配。
- [x] 2.6 修改归位后的 `HumanApprovalPlugin.ts` 等三个内置核心拦截器，确保它们在 `core/usecases/` 物理归位后，通过合法的 import 直接引用需要的核心服务（如 `SecurityService`、`ApprovalService` 等），解除先前强耦合核心实体的环状依赖。

<!-- checkpoint: npx tsc --noEmit -->

## 3. 测试用例适配与回归自测

- [x] 3.1 审查并修复 `test/` 目录下所有测试套件的导入路径与构造注入签名变动（例如：为单元测试中的 `SessionManager` / `AgentLoop` 提供 mock 版本的 `ToolRegistryPort`，为被拆分的 Port 契约提供极简 Stub 等）。
- [x] 3.2 运行全量 Vitest 回归测试，确保全部 20 个测试套件，98 个测试用例再次 100% 成功通过，无任何功能倒退。

<!-- checkpoint: npm run test -->

## 4. [调试修正] 插件彻底归位与类型契约纯化对齐

- [x] 4.1 物理移动其余两个拦截插件：
  - 将 `src/adapters/plugins/TracerLogPlugin.ts` 移动至 `src/core/usecases/TracerLogPlugin.ts`
  - 将 `src/adapters/plugins/LoopPreventionPlugin.ts` 物理移动至 `src/core/usecases/LoopPreventionPlugin.ts`
  级联修正 `src/core/usecases/session.ts` 等各处的相对物理导入，并更新 `src/adapters/plugins/index.ts` 移除它们的 re-export。
- [x] 4.2 物理新建 `src/ports/driven/McpManagerPort.ts` 契约接口，在 `ToolRegistryPort` 接口中暴露 `readonly mcpManager?: McpManagerPort`。让外围 `McpToolManager` 具体适配器实现 `McpManagerPort`。
- [x] 4.3 升级 `ToolRegistryPort.callTool` 签名，将 `sessionContext` 入参的类型拓宽为 `SessionEventPort & ApprovalPort` 交集，对齐其具体实现的签名契约。
- [x] 4.4 消除 `src/adapters/input/interface/commands/mcp.ts` 和 `tool.ts` 对 `toolRegistryInstance` 获取时的 `as any` 强转，完全改用强类型的 `mcpManager` 进行连接和状态管理。
- [x] 4.5 修复单元测试中对移回 Core 后的 `TracerLogPlugin` 和 `LoopPreventionPlugin` 的导入路径，确保测试正确导入。

<!-- checkpoint: npx tsc --noEmit -->
<!-- checkpoint: npm run test -->
