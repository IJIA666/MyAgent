## 背景

当前 `ModelRequestAssembler` 先运行 `BeforeModel` 插件，再注入 system-reminder 和裁剪 Plan 模式工具。`TokenWatermarkPlugin` 权重为 10，而会修改消息的 `LongTermMemoryPlugin` 权重为 50，因此现有水位检查既早于后续插件，也看不到最终 reminder 和最终工具集合。插件只估算 messages，超过阈值后直接调用 `CompactionService.compactInHook()`；压缩成功只表示摘要已写入，不表示新请求已回到安全水位。

`CompactionService` 当前只有中段策略，无条件完整保护最新用户轮。若该轮本身已占用大量预算，中段摘要可能无法产生足够收益。`AgentLoop` 收到 restart 后会回退 iteration 并立即重组请求，没有连续压缩 restart 上限。

工具执行链已经把超大输出落盘，并在运行时对象上写入 `originalPath` 与 `isTruncated`，但 `ChatMessage` 尚未声明这些字段。该结构可以成为可恢复工具结果剪枝的可靠依据，无需解析提示文本。设计依据保留在 `openspec/explorations/system-prompt-competitive-research.md`，不移动到 change 内。

## 目标与非目标

**目标:**

- 在最终模型请求边界估算 messages、tools 和输出预留构成的完整预算。
- 在调用摘要模型前执行可恢复工具结果剪枝，并在剪枝后重新估算。
- 在第一次摘要前一次性选择 `none`、`middle` 或 `full`，避免先中段再全量。
- 为全量压缩生成可继续正常对话的检查点摘要，不改变 Agent 身份。
- 对摘要膨胀、收益不足、持久化失败和连续 restart 保持原子失败。
- 让自动与手动压缩复用同一规划、执行和结果类型。
- 将 provider 上下文溢出规范化为稳定错误，并最多执行一次强制全量恢复。

**非目标:**

- 不实现单条 user/assistant 消息的分块摘要或 map-reduce。
- 不对普通 user/assistant 历史执行静默硬截断。
- 不引入独立压缩模型、多模型路由或新的运行时配置项。
- 不重做读取 Stub、工具输出落盘格式、长期记忆或 Goal 状态模型。
- 不移动或复制现有探索文件。

## 架构决策

### 1. 在最终请求组装边界运行预算协调，而不是依赖插件权重

在 `src/core/usecases/engine/model-request-assembler.ts` 中完成 `BeforeModel` 插件、system-reminder 注入和 Plan 工具裁剪后，再调用新的上下文预算协调器。协调器接收最终 `LlmRequest`、当前持久历史、模型配置和可选手动偏好，返回最终请求投影或 restart/失败结果。

`TokenWatermarkPlugin` 的 `BeforeModel`、`PreCompact` 注册及 Session 装配将被移除；`PreCompact` 当前没有生产触发点，不再作为双重保护。预算协调是模型发送前的固定阶段，不允许后续步骤再次修改 messages/tools。

选择该边界而不是单纯提高插件权重，是因为权重只能约束当前插件集合，无法保证未来更高权重插件或 Hook 外 reminder 不改变请求。

### 2. 引入纯规划器和独立可恢复剪枝器

新增 `ContextBudgetPlanner`，只负责计算和决策，不调用 LLM、不持久化历史。规划器输出结构化 `ContextBudgetPlan`，至少包含：输入预算、tools 预算、输出 reserve、安全阈值、剪枝节省量、候选策略、预计压缩后上界和选择原因。

新增 `ContextHistoryPruner`，返回消息副本和剪枝统计，不修改 `SessionContext`。首期只允许两种自动剪枝：

1. 对受保护近期尾部之外、带 `isTruncated=true` 和 `originalPath` 的旧 tool 消息，将长预览替换为包含工具调用 ID、落盘路径和截断事实的短引用；
2. 对受保护尾部之外内容完全相同的 tool 消息，保留最新完整副本，将更早副本替换为指向最新 `tool_call_id` 的重复标记。

所有 tool 消息必须保留 role、`tool_call_id` 和错误文本；没有落盘引用且不重复的工具结果不得自动删减。剪枝首先作用于本次请求投影；若随后生成摘要，摘要输入使用同一剪枝视图，但持久历史只在有效摘要提交时整体替换。

不采用“所有工具都可重跑”的方案，因为 write/unknown 工具可能有副作用，重新执行不是可靠恢复手段。

### 3. 扩展 TokenEstimatorPort 估算完整请求

在 `TokenEstimatorPort` 增加完整请求估算方法，输入最终 messages、tools、上次真实 usage 基线和输出 reserve。`TiktokenEstimator` 复用现有消息估算，并对工具 Schema 的稳定 JSON 序列化结果计数；最终比较值为输入估算加模型输出 reserve。

自动阈值继续使用 `contextWindow * compactionWatermarkFactor`，不新增配置。正常模型请求的 reserve 使用当前 `LlmConfig.maxTokens`；摘要请求使用 `compactionSummaryMaxTokens`，并单独验证摘要输入加输出预算不超过物理 `contextWindow`。

候选历史已经改变时不能沿用旧 API usage 作为绝对值，规划器应使用本地消息估算比较 middle/full 的相对上界；真实 usage 仅用于当前未改写请求的校准。

### 4. 摘要前一次性选择 middle 或 full

规划器按以下顺序决策：

1. 估算最终请求；未超过安全阈值时返回 `none`；
2. 执行可恢复剪枝并重新估算；已安全时返回 `none` 和剪枝后的请求投影；
3. 计算 middle 候选上界：固定请求开销 + system 头部 + 受 token/轮数双预算约束的完整近期尾部 + 最大摘要输出；
4. 仅当存在安全中段、摘要请求可容纳源材料、且 middle 候选预计回到安全阈值时选择 `middle`；
5. 其他情况直接选择 `full`，不先调用中段摘要。

最新完整用户轮不再突破 `compactionRetainTokens` 获得无条件保护。若无法在预算内保留至少一个完整近期轮，middle 判定为不可行并选择 full。

### 5. CompactionService 生成候选历史并返回结构化结果

`CompactionService` 接受 `ContextBudgetPlan` 或手动 `auto/full` 偏好，返回 `CompactionResult`，而不是布尔值。结果至少包含状态、实际策略、压缩前后估算、剪枝节省量和失败原因。

- `middle`：沿用现有历史型中段摘要协议，输出 `[Summary of Earlier Conversation]`，保留预算内的完整近期轮；
- `full`：新增完整检查点摘要协议，把全部非 system 持久历史作为源材料，覆盖当前目标、用户约束、已完成工作和验证、关键决定、当前状态、阻塞、下一步及继续所需的精确资源；输出 `[Conversation Checkpoint]`，新历史仅保留连续 system 前缀和检查点，不生成 handoff、领导者或子单元身份；
- Goal 模式已有结构化目标信息可作为正常消息源材料参与摘要，但不建立单独算法。

服务先生成候选历史，再结合规划器提供的固定请求开销重新估算。只有候选输入比剪枝后输入更小且不超过安全阈值，才更新内存历史并保存。摘要失败、空白、膨胀、仍超阈值或保存失败均恢复原历史。

### 6. 手动命令复用同一链路并公开实际结果

将 `CliSessionUseCase.compact()` 和 Session 转发签名改为接受可选 `auto | full` 偏好并返回 `CompactionResult`。`/compact` 默认使用 `auto` 规划；`/compact full` 强制选择 full，但仍必须通过摘要输入可容纳性和结果验证，不能绕过安全检查。其他参数返回用法错误。

CLI 根据结构化结果显示实际策略、压缩前后预算或明确失败原因，不再把所有 false 合并为“轮数太少、锁定或熔断”。help 文案同步说明默认自动选择及 full 参数。

### 7. 对连续 restart 和 provider 溢出建立一次性恢复状态

`AgentLoop` 增加仅存在于当前 run 的预算恢复状态，记录真实模型调用前的连续 compaction restart 次数、上次策略和 provider 溢出恢复是否已使用：

- preflight 规划最多产生一次 compaction restart；若重组后仍要求再次压缩，则返回明确错误，不再次摘要；
- 一次真实模型调用成功后清空连续 restart 状态，使后续工具轮可以基于新增历史重新规划；
- `LlmPort` 增加稳定的 `LlmContextWindowExceededError`。OpenAI adapter 优先根据 SDK 结构化 status/code/type 识别，并仅对已知兼容端点文本模式做保守 fallback；
- provider 首次返回该错误且本次尚未执行 full 时，下一次规划强制 full；若已经 full、恢复已使用或 full 后仍溢出，则保留当前历史并返回错误。

不采用无上限重试，也不把普通 400、网络超时或认证错误当成上下文溢出。

## 风险与权衡

- **本地 token 估算与 provider 实际计数存在偏差** -> 保留 watermark 安全余量，计入工具 Schema 和输出 reserve，并允许一次结构化溢出恢复。
- **全量摘要可能遗漏最新细节** -> 使用独立检查点 prompt、保留精确资源和当前状态要求，并在结果不缩小或仍超限时拒绝提交。
- **请求投影剪枝与持久历史不同步可能增加理解成本** -> 只剪可恢复或重复的 tool 内容，保留协议结构和引用；trace 记录剪枝数量与节省量。
- **重构水位插件可能影响 Hook 生命周期测试** -> 用 assembler 最终边界集成测试替代插件权重测试，并验证长期记忆、reminder 和最终工具集合都已计入。
- **兼容端点的溢出错误格式不统一** -> 结构化字段优先、文本 fallback 白名单化；无法确认时按普通模型错误处理，不擅自压缩。
- **`/compact` 返回类型改变会影响测试和调用方** -> 一次性更新 `CliSessionUseCase`、Session、命令及 mock，项目尚无外部稳定 API 包袱。

## 迁移计划

1. 先补齐 `ChatMessage` 工具输出元数据、完整请求估算和纯 pruner/planner，并以单元测试固定决策行为。
2. 扩展摘要 prompt 与 `CompactionService`，引入结构化结果、full 候选和提交前验证；迁移现有中段测试。
3. 将预算协调接入 `ModelRequestAssembler` 最终阶段，移除 `TokenWatermarkPlugin` 注册和无效 `PreCompact` 挂载，增加连续 restart 熔断。
4. 更新 `/compact` 端口、命令、help 和 provider 溢出错误规范化。
5. 完成 assembler、AgentLoop、适配器和手动命令集成测试后，删除只保护旧插件权重行为的测试。

持久化历史格式无需批量迁移：旧消息缺少 `originalPath/isTruncated` 时视为不可剪枝；既有 `[Summary of Earlier Conversation]` 继续作为普通历史参与后续规划。回滚时可恢复旧水位插件和布尔压缩接口，已产生的 `[Conversation Checkpoint]` 仍是合法 user 历史消息，不阻止旧版本读取。

## 开放问题

无。单消息分块、摘要输入硬截断、独立压缩模型和更复杂的语义工具结果路由均明确延后，只有出现真实运行证据时再单独提案。
