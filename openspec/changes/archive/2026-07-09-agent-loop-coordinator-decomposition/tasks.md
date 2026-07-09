## 1. 创建 ApprovalEffectApplier（审批效果提交协作者）

- [x] 1.1 新建 `src/core/usecases/engine/approval-effect-applier.ts`，定义 `ApprovalEffectApplier` 类
- [x] 1.2 实现 `applyPendingGrant()` 方法：收敛 `PendingGrant` 的 call/session 分流逻辑（call capability 注册 + 会话级白名单写入）
- [x] 1.3 实现 `applyPersistentRuleEffect()` 方法：收敛持久化安全白名单的 prefix 规则落盘逻辑
- [x] 1.4 在 `AgentLoop.chat()` 中将主调用路径的 pendingGrant/persistentRuleEffect 提交替换为 `ApprovalEffectApplier` 委托调用
- [x] 1.5 在 `AgentLoop.chat()` 中将 tail call 路径的 pendingGrant/persistentRuleEffect 提交替换为 `ApprovalEffectApplier` 委托调用
- [x] 1.6 编写 `ApprovalEffectApplier` 单元测试（call 类型 grant、session 类型 grant、persistentRuleEffect、command-prefix 过滤）

<!-- checkpoint: npm run build -->

## 2. 创建 ModelRequestAssembler（模型请求组装协作者）

- [x] 2.1 新建 `src/core/usecases/engine/model-request-assembler.ts`，定义 `ModelRequestAssembler` 类及其构造函数依赖
- [x] 2.2 实现 `assemble()` 方法：保持当前真实顺序整合 `toolRegistry.getTools()` → `BeforeToolSelection` 管线 → `contextAdapter.assemble()` → `BeforeModel` 管线 → `system-reminder` 注入 → Plan 模式工具裁剪
- [x] 2.3 在 `AgentLoop.chat()` 中将模型请求组装阶段替换为 `ModelRequestAssembler.assemble()` 委托调用
- [x] 2.4 验证 `BeforeToolSelection` 与 `BeforeModel` 管线的 restart/abort 控制流在委托后行为不变
- [x] 2.5 编写 `ModelRequestAssembler` 单元测试（普通模式请求组装、Plan 模式工具裁剪、system-reminder 注入格式）

<!-- checkpoint: npm run build -->

## 3. 创建 ToolCallOrchestrator（工具调用编排协作者）

- [x] 3.1 新建 `src/core/usecases/engine/tool-call-orchestrator.ts`，定义 `ToolCallOrchestrator` 类及其构造函数依赖
- [x] 3.2 迁移 `resolveFilePaths` 纯函数到 orchestrator 模块（保持为私有函数或静态方法）
- [x] 3.3 实现 `execute()` 方法：封装参数解析 → BeforeTool 管线 → 审批效果委托 → 文件锁/备份 → toolRegistry.callTool() → AfterTool 管线 → tail call 级联 → capability 消费 → 错误恢复
- [x] 3.4 处理 `InteractionRequestError` 与 `human_interruption` 模式的中断挂起逻辑
- [x] 3.5 在 `AgentLoop.chat()` 中将 `executeToolTask` 闭包替换为 `ToolCallOrchestrator.execute()` 委托调用
- [x] 3.6 保留并发调度逻辑（`Promise.allSettled` + suspend 事件队列）在 `AgentLoop` 中，仅将单工具执行委托出去
- [x] 3.7 验证 AfterTool 管线的 abort 控制流与 tail call 级联在委托后行为不变
- [x] 3.8 编写 `ToolCallOrchestrator` 单元测试（正常执行路径、BeforeTool abort、AfterTool abort、tail call 级联、InteractionRequestError 挂起）

<!-- checkpoint: npm run build -->

## 4. AgentLoop 协调器收敛与清理

- [x] 4.1 在 `AgentLoop` 构造函数中实例化三个协作者，调整 `AgentLoopOptions` 的依赖分配（保持对外签名兼容）
- [x] 4.2 精简 `chat()` 方法：移除外移的私有辅助逻辑，仅保留 ReAct 主循环骨架、AfterModel 调度、trace 落盘、缓存诊断、PostRunHook 与状态持久化
- [x] 4.3 删除 `chat()` 中已外移的 `executeToolTask` 闭包定义和重复的 pendingGrant/persistentRuleEffect 代码块
- [x] 4.4 确认 `resetTraceState()` 中的缓存状态重置在协作者模式下仍然正确工作
- [x] 4.5 运行全量单元测试，确认重构前后行为一致

<!-- checkpoint: npm run build -->
<!-- checkpoint: npm test -->
