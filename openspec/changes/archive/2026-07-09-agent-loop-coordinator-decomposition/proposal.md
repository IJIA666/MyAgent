## 改造原因

`AgentLoop` 作为单次会话 ReAct 推理的执行引擎，当前已承载过多职责：模型请求组装、运行时提醒注入、工具并发调度、审批效果提交、持久白名单写入、trace 落盘、质量检查、缓存诊断与状态保存均耦合在同一个 `chat()` 方法中。文件长度已超过 1100 行，`chat()` 方法体本身占据约 900 行，形成事实上的上帝类。

核心痛点：
- **重复逻辑**：`pendingGrant` 与 `persistentRuleEffect` 的提交逻辑在主工具调用与 tail call 中各自复制了一份，维护成本高且容易产生行为漂移。
- **职责混杂**：模型请求的前处理（上下文组装、提醒注入、Plan 模式裁剪）与工具执行的并发编排、审批效果落盘交织在一起，任意一环变更都需要触碰主循环。
- **依赖面过宽**：直接依赖 12 个以上的端口与服务，协作面过大导致任何外部接口变更都容易波及 `AgentLoop`。

本次改造聚焦于执行链路内部重构，不改变任何外部接口契约，以降低风险并提升后续扩展性。

## 变更内容

- 从 `AgentLoop.chat()` 中拆出 **`ModelRequestAssembler`**：收敛模型请求的组装逻辑，包括上下文适配、系统提醒注入、Plan 模式工具裁剪以及 BeforeModel 插件管线的调度。
- 从 `AgentLoop.chat()` 中拆出 **`ApprovalEffectApplier`**：集中处理 `pendingGrant`（call capability 注册与会话级白名单写入）与 `persistentRuleEffect`（持久化安全白名单落盘），消除主调用与 tail call 之间的重复代码。
- 从 `AgentLoop.chat()` 中拆出 **`ToolCallOrchestrator`**：封装单个工具调用的完整生命周期——参数解析、BeforeTool/AfterTool 管线、文件锁与备份、tail call 级联、capability 消费与错误恢复。
- `AgentLoop` 自身退化为协调器，仅保留 ReAct 主循环骨架、缓存诊断与 PostRunHook 质量检查调度。

以上均为纯内部重构，**不涉及 BREAKING 变更**。

## 业务能力

### 新增业务能力

本次为纯技术重构，不引入新的业务能力。

### 修改业务能力

本次为纯技术重构，不修改任何既有业务能力的需求规格。

## 影响范围

- **核心文件**：[src/core/usecases/engine/agent-loop.ts](src/core/usecases/engine/agent-loop.ts) — 职责收敛，析出新协作者文件。
- **新增文件**（均在 `src/core/usecases/engine/` 下）：
  - `model-request-assembler.ts`
  - `approval-effect-applier.ts`
  - `tool-call-orchestrator.ts`
- **间接影响**：`AgentLoopOptions` 接口中的依赖项分配将随协作者拆分而重新分布，但 `AgentLoop` 构造函数的签名保持兼容。
- **不涉及**：`SessionManager`、`ToolRegistryPort`、`PluginRegistry` 等外部协作者无需变更。
