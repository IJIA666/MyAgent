# 探索主题: AgentLoop 协调器拆分与执行边界收敛

## 1. 问题定义
当前 `src/core/usecases/engine/agent-loop.ts` 已成为单次会话执行链路中的超重协调器。它不仅负责 ReAct 主循环，还同时承担模型请求组装、运行时提醒注入、工具并发调度、审批结果提交、持久白名单写入、trace 落盘、质量检查、缓存诊断和状态保存等职责，导致内聚度下降、变更面过宽、重复逻辑增加，已经逼近上帝类。

## 2. 关键发现与调研结果
- **代码库现状**：`AgentLoop.chat()` 是主入口，方法体极长，跨越模型前处理、工具执行、插件生命周期和会话落盘多个阶段。普通工具调用与 tail call 各自重复提交 `pendingGrant` 与 `persistentRuleEffect`，说明授权效果应用逻辑没有被提炼成独立能力。
- **代码库现状**：`AgentLoop` 内部直接拼装 `<system-reminder>`、Plan 模式工具裁剪、模型超时、工具超时和缓存诊断，说明运行时策略分散在执行大循环内部，而不是集中在明确的策略对象中。
- **代码库现状**：`AgentLoop` 同时依赖 `ToolRegistryPort`、`ContextAdapter`、`RuleManager`、`ContextRepository`、`ToolDispatcher`、`CompactionService`、`PluginRegistry`、`QualityCheckPort`、`InteractionPort`，协作面过大，导致任何一类变更都容易波及主循环。
- **核实与洞察**：这不是单纯“文件太长”的问题，而是执行编排、授权效果提交和工具任务生命周期交织。后续如果继续增加浏览器工具、审批语义或异步工具尾随调用，复杂度会继续在 `AgentLoop` 内线性累积。

## 3. 方案对比与推荐方向
| 评估维度 | 方案 A：继续在 `AgentLoop` 内局部整理 | 方案 B：按执行阶段拆出协作者 | 结论 |
| :--- | :--- | :--- | :--- |
| 改动成本 | 低 | 中 | A 占优 |
| 降低复杂度效果 | 弱，只能缓解长度 | 强，可直接削减职责混杂 | B 占优 |
| 消除重复逻辑 | 弱，容易继续复制粘贴 | 强，可集中沉淀授权效果应用 | B 占优 |
| 后续扩展审批/工具链 | 差，仍要回到主循环加分支 | 好，新增策略落到局部对象 | B 占优 |
| 风险可控性 | 中，短期看似安全 | 中，需要明确阶段边界 | 平手 |

**推荐路径**：采用方案 B，但只做执行链路内部重构，不同时改外围接口。优先从 `AgentLoop` 中拆出 3 类协作者：`ModelRequestAssembler`、`ToolCallOrchestrator`、`ApprovalEffectApplier`。其中 `ApprovalEffectApplier` 应集中处理 `pendingGrant`、`persistentRuleEffect`、call capability 注册与 session 级白名单写入，先消除主调用与 tail call 的重复逻辑。

## 4. 约束、风险与未知项
- `AgentLoop` 当前处于真实执行链路中心，边界是 `SessionManager -> AgentLoop -> ToolRegistryPort.callTool -> tool.execute()`，拆分时不能破坏现有插件生命周期顺序。
- 审批效果提交与 capability 消费顺序非常敏感，若拆分不当，容易引入“先执行后授权”或“授权未消费”的状态错误。
- `AfterModel`、`BeforeTool`、`AfterTool` 与 PostRunHook 的时序已经耦合在主循环里，重构前需要先把阶段契约写清楚。
- `ContextRepository.saveState()` 目前分布在多个 finally 和中断分支，后续需要明确哪些属于 run 级收尾，哪些属于 tool 级收尾。

## 5. 否决方案
- **继续依靠注释和局部私有函数缓解大方法**：这只能改善可读性，不能消除职责交叉和重复授权提交逻辑。
- **一次性把 AgentLoop 与 SessionManager 同时大拆**：边界过大，风险高，会把原本独立可验证的问题重新耦合在一起。
