## 1. 基础设施：ApprovalService 开发与注入

- [x] 1.1 创建 `src/brain/services/ApprovalService.ts`，实现 `wait`（含 5 分钟超时与 Bypass 模式）、`resolve`、`reject` 与 `rejectAll` 核心方法。
- [x] 1.2 更新 `src/brain/context.ts`：引入并实例化 `ApprovalService`。同时，将 `allowed_commands.json`（或相关白名单机制）的加载与保存职责从动作层彻底解耦，在 `SessionContext` 内实现并维护 `securityAllowlist`，消解脑部对动作配置层的反向依赖。
- [x] 1.3 更新 `src/brain/agent-loop.ts` 的 `AgentEvent` 联合类型定义，新增 `{ type: 'suspend'; id: string; toolCall: { name: string; arguments: Record<string, unknown> }; allowedPrefix: string | null }`。

<!-- checkpoint: npm run build -->

## 2. 核心拦截器：HumanApprovalPlugin 开发与注册

- [x] 2.1 创建 `src/brain/plugins/HumanApprovalPlugin.ts`，实现 `BeforeTool` 中间件拦截逻辑（包含高危正则匹配嗅探）。
- [x] 2.2 在 `HumanApprovalPlugin` 中实现事件抛出 `context.emitEvent({ type: 'suspend' })` 以及基于 `ApprovalService.wait` 的原生挂起与放行/拒绝/白名单写入动作。
- [x] 2.3 更新 `src/brain/session.ts`：将 `HumanApprovalPlugin` 装载到 `PluginRegistry` 的洋葱管道中，并透传必要的 `ApprovalService`。

<!-- checkpoint: npm run build -->

## 3. 工具层解耦：移除遗留的耦合交互

- [x] 3.1 梳理 `src/action/native-tools/terminal.ts` （或相关包含 `askUserPermission` 的入口），彻底移除内置的 `readline` 交互阻塞代码。
- [x] 3.2 验证终端工具代码已退化为无交互拦截的纯执行态函数。
- [x] 3.3 更新 `src/interface/facade.ts`（或其他 CLI/Web 宿主入口）：在 `runStreamLoop` 等循环中新增对 `suspend` 类型的消费分支，挂起常规输入监听并弹出交互菜单，接收用户输入后调用 `session.approvalService.resolve(id, decision)` 唤醒内核。

<!-- checkpoint: npm run build -->

## 4. 强类型化重构与 Any 消除（代码质检返工）

- [x] 4.1 修复 `src/brain/session.ts`：显式导入 `ApprovalService`，将 `public get approvalService()` 的返回类型 `any` 重构为 `ApprovalService` 强类型。
- [x] 4.2 修复 `src/brain/plugins/HumanApprovalPlugin.ts`：移除所有的 `as any` 强制类型转换，直接利用 `SessionContext` 的强类型属性。

<!-- checkpoint: npm run build -->

- [x] 4.3 修复 `src/brain/plugins/HumanApprovalPlugin.ts` 中的正则无用转义错误：将 `[\/\*~]` 重构为 `(\/|\*|~)` 以消除 IDE 静态分析中的无用转义告警。

<!-- checkpoint: npm run build -->

