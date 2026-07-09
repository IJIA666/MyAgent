## 背景

`AgentLoop` 是 ReAct 推理大循环的单一执行引擎。当前 `chat()` 方法跨越约 900 行，直接编排模型请求组装、工具并发调度、审批效果落盘、trace 日志、缓存诊断、质量检查与状态持久化全部环节。三类逻辑在方法内高度交织：

1. **模型请求前处理**（~80 行）：BeforeToolSelection 管线、上下文装配、系统提醒注入、BeforeModel 管线、Plan 模式工具裁剪。
2. **工具调用生命周期**（~500 行）：`executeToolTask` 闭包内封装了参数解析、BeforeTool/AfterTool 管线、文件锁与备份、实际工具执行、tail call 级联、capability 消费与错误恢复。
3. **审批效果提交**（~60 行，重复 2 次）：`pendingGrant` 的 call/session 分流与 `persistentRuleEffect` 的持久化白名单写入在主调用与 tail call 中各存在一份完整副本。

本次重构目标是将上述三类逻辑拆分为独立的协作者对象，使 `AgentLoop` 退化为仅持有 ReAct 主循环骨架的薄协调器。

## 目标与非目标

**目标:**
- 将模型请求组装逻辑收敛到 `ModelRequestAssembler`，消除 `chat()` 中与模型调用无关的前处理噪声。
- 将审批效果提交逻辑收敛到 `ApprovalEffectApplier`，消除主调用与 tail call 之间的重复代码。
- 将工具调用生命周期（含 tail call 级联）收敛到 `ToolCallOrchestrator`，使并发调度与错误恢复逻辑可独立测试。
- 保持现有插件生命周期顺序（RunStart → BeforeToolSelection → BeforeModel → AfterModel → BeforeTool → AfterTool → RunEnd）完全不变。
- `AgentLoop` 的公开 API（`chat()` 方法签名、`AgentEvent` 类型、`AgentLoopOptions` 接口）保持兼容。

**非目标:**
- 不修改 `SessionManager` 或任何 `AgentLoop` 上游调用方。
- 不修改 `ToolRegistryPort`、`PluginRegistry`、`ContextAdapter` 等端口接口。
- 不引入新的插件 Hook 事件或修改现有 Hook 语义。
- 不改变工具并发执行策略（仍为 `Promise.allSettled` 并行模式）。
- 不同时对 `CompactionService` 或 `ContextRepository` 做职责调整。

## 架构决策

### 决策 1：按执行阶段纵向拆分，而非按功能横向切面

**选择**：将 `chat()` 拆分为三个阶段协作者——`ModelRequestAssembler`（模型调用前）、`ToolCallOrchestrator`（工具执行中）、`ApprovalEffectApplier`（授权效果提交）。

**Why**：纵向拆分使每个协作者的执行边界与插件生命周期 Hook 天然对齐：`ModelRequestAssembler` 覆盖 `getTools()` → `BeforeToolSelection` → `contextAdapter.assemble()` → `BeforeModel`，并在其后保持当前的 `system-reminder` 注入与 Plan 模式工具裁剪顺序；`ToolCallOrchestrator` 覆盖 BeforeTool → 工具执行 → AfterTool（含 tail call）；`ApprovalEffectApplier` 作为横切能力被工具执行阶段复用。`RunStart` 仍保留在 `AgentLoop` 最外层，不并入请求组装协作者。

**替代方案**：按技术关注点横向拆分（如独立的"管线调度器"、"文件锁管理器"等）。被否决，因为横向切面会增加调用链深度，且无法消除主调用与 tail call 的重复逻辑。

### 决策 2：`ApprovalEffectApplier` 作为无状态工具类

**选择**：`ApprovalEffectApplier` 不持有内部状态，仅接收 `SessionContext` 参数执行副作用写入。

**Why**：审批效果提交的核心逻辑是纯副作用操作（写入白名单、注册 capability），状态全部存储在 `SessionContext` 中。无状态设计使其可以在主调用和 tail call 中安全复用，无需考虑并发隔离。

**替代方案**：将审批效果提交下沉到 `SessionContext` 自身的方法中。被否决，因为这会进一步膨胀已经很大的 `SessionContext`，且与 domain 层的职责定位不符。

### 决策 3：`ToolCallOrchestrator` 封装单次工具调用的完整生命周期

**选择**：由单个 `ToolCallOrchestrator` 协作者通过 `execute()` 方法处理一次工具调用（含可能的单个 `tailToolCallRequest` 级联），返回 `ToolExecutionResult`。

**Why**：将当前 `executeToolTask` 闭包的逻辑完整迁移到独立类中，使其可独立进行单元测试。tail call 的级联执行内聚在同一个 orchestrator 中，避免主循环需要感知 tail call 的存在。

**替代方案**：将 tail call 提升为主循环的一轮额外迭代。被否决，因为 tail call 的审批语义与主调用共享同一个 `BeforeTool` 上下文，拆分会破坏审批状态的连续性。

### 决策 4：`AgentLoop` 保留缓存诊断与 PostRunHook 调度

**选择**：`checkCacheAndCalibrate()` 保留在 `AgentLoop` 中，PostRunHook（质量检查触发）也保留在主循环骨架中。

**Why**：缓存诊断依赖 `AgentLoop` 内部的 `lastCacheReadTokens`、`lastSystemPromptHash` 等跨迭代状态，这些状态与 ReAct 循环的生命周期紧密绑定，不适合同步外移。PostRunHook 的触发条件（`hasWriteOperation && qualityCheckPort`）是 run 级别的决策，属于协调器职责。

**替代方案**：将缓存状态独立为 `CacheDiagnostics` 对象。当前不采纳，因为缓存状态仅服务于诊断日志输出，抽象收益有限，留待后续迭代评估。

### 决策 5：三个协作者在构造期实例化，通过构造函数注入依赖

**选择**：`ModelRequestAssembler`、`ToolCallOrchestrator`、`ApprovalEffectApplier` 在 `AgentLoop` 构造函数中实例化，通过构造函数接收各自所需的端口依赖。

**Why**：与 `AgentLoop` 自身依赖注入模式一致，保持全项目统一的装配风格。避免引入 DI 容器或服务定位器。

**替代方案**：在 `chat()` 方法中按需创建协作者。被否决，因为这会让执行路径继续夹杂对象装配噪声，也不利于测试注入与阶段职责收敛。

## 数据流

```
AgentLoop.chat()
  │
  ├─ ModelRequestAssembler.assemble(transientSkillContent)
  │   ├─ toolRegistry.getTools()            → 当前可用工具集
  │   ├─ BeforeToolSelection 管线           → 插件过滤/改写工具集
  │   ├─ contextAdapter.assemble()          → 历史消息 + 临时技能
  │   ├─ BeforeModel 管线                   → 插件拦截/改写请求
  │   ├─ 注入 <system-reminder>             → 日期/CWD/安全模式
  │   └─ Plan 模式工具裁剪                  → 过滤 write 类工具
  │   → 返回 { messages, tools }
  │
  ├─ driver.streamChat(messages, tools)      → LLM 流式响应
  │
  ├─ [若存在 tool_calls]
  │   └─ ToolCallOrchestrator.execute(toolCall, signal)
  │       ├─ BeforeTool 管线                 → 插件拦截/审批
  │       ├─ ApprovalEffectApplier.apply*()  → 在实际 tool.execute() 前提交授权效果
  │       ├─ toolRegistry.callTool()         → 实际执行
  │       ├─ AfterTool 管线                  → 结果改写
  │       ├─ [tail call] 递归同上
  │       └─ capability 消费
  │       → 返回 ToolExecutionResult
  │
  ├─ tracer.logIteration()                   → trace 落盘
  ├─ checkCacheAndCalibrate()                → 缓存诊断
  ├─ [PostRunHook] qualityCheckPort.run()    → 质量检查
  └─ contextRepo.saveState()                 → 状态持久化
```

## 风险与权衡

- **[插件时序敏感]**：BeforeModel → AfterModel → BeforeTool → AfterTool 的顺序已经耦合在主循环中。拆分后 `ModelRequestAssembler` 负责 BeforeModel，`ToolCallOrchestrator` 负责 BeforeTool/AfterTool，但 AfterModel 的触发时机（在收到工具调用后、执行前）仍需要在 `AgentLoop` 中显式调度。→ **缓解**：在 `ToolCallOrchestrator.execute()` 的入口处由 `AgentLoop` 先完成 AfterModel 管线并传入改写后的 assistantMessage，确保时序不变。

- **[审批效果提交顺序]**：`pendingGrant` 与 `persistentRuleEffect` 当前都发生在 `BeforeTool` 管线成功返回之后、`toolRegistry.callTool()` 之前。若改成后置提交，会改变真实安全语义。→ **缓解**：`ApprovalEffectApplier` 仅封装“前置提交”能力，并保持 `control.action === 'continue'` 与 `toolCallId` 匹配等守卫条件不变。

- **[测试覆盖真空]**：拆分前 `AgentLoop.chat()` 几乎没有直接单元测试（依赖完整的会话生命周期），拆分后协作者可以独立测试，但需要新建测试文件。→ **缓解**：在 `tasks.md` 中明确列出每个协作者的最小测试场景，但不作为本次重构的阻塞条件。

- **[tail call 递归深度]**：当前 tail call 仅支持一级，`ToolCallOrchestrator` 封装后仍保持此限制。若未来需要多级 tail call 级联，需在 orchestrator 内部改为循环。→ **缓解**：在 orchestrator 的文档注释中明确标注当前限制，降低未来误用的风险。

## 迁移计划

1. 创建三个协作者文件，每个包含独立的类定义与单元测试骨架。
2. 在 `AgentLoop` 构造函数中实例化协作者，替换原有内联逻辑。
3. `chat()` 方法中：
   - 模型请求组装阶段 → 委托 `ModelRequestAssembler.assemble()`
   - 审批效果提交 → 委托 `ApprovalEffectApplier.applyPendingGrant()` / `applyPersistentRuleEffect()`
   - 工具执行 → 委托 `ToolCallOrchestrator.execute()`
4. 删除 `chat()` 中的 `executeToolTask` 闭包和重复的 pendingGrant/persistentRuleEffect 代码块。
5. 运行现有编译与静态检查，确保无类型错误。
6. **回滚策略**：所有变更集中在 `src/core/usecases/engine/` 目录，若出现问题直接回退新增协作者与 `AgentLoop` 的重构改动即可，不涉及数据迁移。
