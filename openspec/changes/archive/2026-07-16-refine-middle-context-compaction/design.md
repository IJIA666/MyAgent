## 背景

变更前生产路径在 `TokenWatermarkPlugin` 超过模型安全水位时调用 `CompactionService.compact()`，保护 system、首轮交互和最近若干 user 轮次，只摘要中段；`/compact` 复用同一入口。与此同时，`AgentLoop` 每轮结束还会调用 `triggerAsyncCompactionIfNeeded()`，周期性总结 system 之后的完整历史，并把 `checkpointSummary`、`recentFiles`、`HANDOFF_INSTRUCTION` 注入后续每次模型请求。两条路径对“摘要是否代表当前任务”给出相反语义，且完整 Checkpoint 路径的角色晋升、固定中文、绝对标识符禁令和静态兜底会造成提示词漂移。

现有中段选择以 `compactionRetainCount` 个 user 消息为唯一尾部边界。默认 4 轮在短对话中有效，但无法限制受保护尾部的 token 体积。摘要模型输入只把 assistant tool call 格式化为工具名称，调用参数会丢失；摘要失败时则用不含真实中段信息的静态文本继续替换历史。这些问题使压缩既可能释放不足，也可能不可逆地丢失关键上下文。

工具结果在进入消息历史前已由 `ToolDispatcher` 根据工具元数据执行 offloading 与头尾预览，因此压缩层可以把历史中的 tool result 视为已经过体积治理的原始会话事实，无需维护第二套截断规则。

## 目标与非目标

**目标:**

- 只保留首尾双保中段压缩，删除异步完整 Checkpoint 及其提示词、状态和配置。
- 按完整用户轮次选择尾部，同时使用“最多轮数”和“token 预算”双重上限，且至少保留最新一个完整用户轮次。
- 让中段摘要明确具有历史参考语义，后续保留原文始终优先，不产生当前任务、待办或下一步。
- 让摘要模型确实看到必要的 assistant 文本、工具名称、工具参数和 tool result，并由独立输出 token 预算控制摘要长度。
- 保证压缩原子性：只有在得到非空有效摘要且存在安全中段时才替换历史；失败不损坏内存或持久化历史。
- 清理不再有消费者的 Checkpoint/recent-files 状态、上下文注入和 runtime limits。

**非目标:**

- 不引入 Claude Code 式完整历史压缩、单侧手动压缩、Session Memory 或 micro-compaction。
- 不改变 Token 水位触发比例、模型 context window 解析或 `/compact` 命令交互。
- 不在压缩层重复实现工具输出落盘、分页读取或预览截断。
- 不改造长期记忆 RAG，也不把压缩摘要写入长期记忆。
- 不移动或复制 `openspec/explorations/system-prompt-competitive-research.md`。

## 架构决策

### 1. 删除完整 Checkpoint 双轨，只保留中段压缩

移除 `triggerAsyncCompactionIfNeeded()` 及 `AgentLoop` 的 after-turn 调用。`SessionContext` 不再保存 `checkpointSummary` 和 `recentFiles`，`ContextRepository` 新快照不再写入这两个字段，加载旧快照时把未知旧字段自然忽略。`ContextAdapter.assemble()` 删除 summary/recentFiles 参数，`ModelRequestAssembler` 不再从会话取出这些状态，`DefaultContextAdapter` 不再生成 `<conversation-checkpoint>`、`HANDOFF_INSTRUCTION` 或 `<recent_files_inventory>`。

中段 `Summary Notice` 本身已经位于 `messageHistory`，会随普通会话消息持久化，因此恢复会话不需要第二份完整 Checkpoint。相比保留双轨并仅润色 handoff，单一历史来源可以避免重复摘要、重复 token 消耗和旧任务被重新激活。

### 2. 使用完整轮次、最大轮数和 token 预算共同选择尾部

`CompactionService` 注入现有 `TokenEstimatorPort`。头部只保护消息历史开头连续的 system 前缀；工具列表通过 `llmRequest.tools` 独立传递，不属于消息历史，也不会被压缩。system 之后的消息按 user 起点划分为完整轮次：一个 user 消息以及下一个 user 之前的 assistant/tool 消息属于同一轮，第一轮与其他较早轮次一样进入可压缩中段。从最新轮向前选择尾部，最多选择 `compactionRetainCount` 轮，并在加入更早轮次后不超过 `compactionRetainTokens`。最新一个完整 user 轮次无条件保留，即使它自身超过预算；不得从 assistant `tool_calls` 与对应 tool result 之间切开。

自动水位压缩发生在 `runHookPipeline()` 的 busy 锁与 Immer draft 内，不能直接改写宿主 `SessionContext`。`CompactionService.compact()` 继续服务手动入口并立即持久化；`compactInHook()` 复用同一私有压缩算法，但通过插件运行器提供的沙箱上下文整体替换 draft history，由 runner 在释放 busy 锁后原子提交，随后沿用 `AgentLoop` 的 `finally` 保存。插件运行器同时负责把插件整体替换后的 `control` 对象同步回外层，压缩成功才向调用方返回 `restart`。

配置默认值为最多 4 轮、尾部 8000 tokens。若头部与尾部重叠、没有中段、消息无法形成安全轮次，压缩返回失败且不改变历史。若最新单轮本身过大，压缩仍不破坏该轮原文；现有 tool-output-offloading 负责在工具结果首次进入历史时控制体积。相比在压缩时再次截断 tool result，这一选择保持协议配对和可审计性；相比继续只按 4 轮计数，token 预算能适配内容体积差异。

### 3. 将提示词收敛为历史中段摘要协议

把 `buildCompactionSummaryPrompt()` 重命名为职责明确的 `buildMiddleCompactionSummaryPrompt()`。system 指令只定义单次摘要任务：输入是较早的中段历史，摘要之后仍有更新的原文，后续原文优先；不得继续对话、回答历史问题、定义当前任务、生成待办或提出下一步。

摘要输出使用固定语义章节：历史目标与背景、历史约束与偏好、已完成事项与结果、关键决定与依据、片段结束状态、问题/错误与有效结论、相关资源与关键事实。正文跟随会话主要语言；只精确保留继续理解所需的路径、命令、错误和标识符；凭据替换为 `[REDACTED]`；不要求输出分析区，也不声称具有工具。

输入序列化使用明确的角色记录，并包含 assistant 可见文本、tool call 的名称与原始 arguments、tool result 的 `tool_call_id` 与内容。内部 `reasoning_content`、运行时私有元数据和 system prompt 不进入中段摘要输入。工具结果已经过 offloading，压缩层不再二次改写。

### 4. 提示词负责语义，运行时负责摘要输出预算

新增 `compactionSummaryMaxTokens`，环境变量为 `AGENT_COMPACTION_SUMMARY_MAX_TOKENS`，默认 4096。`LlmPort.generateSummaryAsync()` 增加可选摘要调用选项，`OpenAiLlmAdapter` 将请求 `max_tokens` 设置为该值与模型通用输出上限中的较小值。提示词只要求简洁，不再硬编码 `1000 字符`。

同时新增 `compactionRetainTokens` / `AGENT_COMPACTION_RETAIN_TOKENS`，默认 8000。保留 `compactionRetainCount` 作为最大 user 轮数。删除仅服务异步完整 Checkpoint 的 `compactionTriggerDelta`、`compactionFailureLimit` 和 `compactionRecentFilesLimit` 及对应环境变量。

### 5. 先生成候选，再原子替换历史

`compact()` 先计算 head/middle/tail 并构建待摘要输入，不提前修改 `SessionContext`。只有摘要调用成功且结果 trim 后非空，才构造 `head + Summary Notice + tail` 并一次性 `updateHistory()`、随后调用现有 `ContextRepository.saveState()`。摘要异常、空结果或无安全中段均返回 `false`，保留原历史。

自动 Hook 路径的“一次性更新”发生在 Immer draft 上，不在 busy 锁内直接持久化；runner 成功完成后才把 draft 提交到宿主会话。手动路径仍直接更新宿主历史并调用仓储。两条入口共享边界选择、摘要协议和失败原子性，不复制第二套压缩实现。

删除 `IDENTIFIER_PRESERVATION_INSTRUCTION`、`HANDOFF_INSTRUCTION` 与 `buildStaticFallbackSummary()`。标识符和敏感信息规则合并进中段摘要协议；模型失败时不再用缺少事实的静态摘要强行丢弃历史。相比确定性拼接“最后工具名/最后用户请求”，失败不变更更符合有损操作的安全边界。

### 6. 测试保护行为而不是旧文案

压缩服务测试使用可控 `TokenEstimatorPort` 验证：最多 4 轮、token 预算收缩、最新轮超预算仍完整保留、工具调用/结果不被切断、头尾重叠不压缩、摘要失败不变更历史、成功时摘要位于原中段。提示词测试验证历史参考语义、禁止当前任务/下一步、工具参数进入输入、同语言与敏感信息规则，不锁定整段文案。

配置、上下文适配器、持久化和模型适配器测试分别验证新参数、旧参数退出、无 Checkpoint 头部注入、旧快照多余字段可被忽略，以及摘要 `max_tokens` 正确下传。

## 风险与权衡

- [最新单轮超过 tail token 预算，压缩后仍可能高于模型水位] -> 无条件保留最新完整轮次并返回真实结果，不在压缩层破坏工具协议；依赖已有 tool-output-offloading 控制单次工具结果，后续若仍有现实案例再独立设计单轮压缩。
- [TokenEstimator 为估算值，轮次选择可能接近预算边缘] -> 使用保守的 8000 token 默认值并以完整轮次为最小单位，相关测试覆盖临界值；不承诺压缩后一定低于所有 provider 的精确计费值。
- [删除 Checkpoint/recent-files 后，旧摘要不再额外注入] -> 中段 `Summary Notice` 已作为普通消息持久化，近期文件路径仍存在于 tool call/result；旧快照中的多余字段加载时忽略，不需要迁移脚本。
- [摘要模型可能受历史文本中的指令干扰] -> system 指令明确历史仅为源材料，输入采用角色化序列化，输出结构固定并禁止继续对话；不把摘要结果提升为 system/developer 消息。
- [删除静态兜底后，模型故障时无法释放上下文] -> 保留原历史并向现有 Token 水位调用方返回失败，避免静默数据丢失；不自动回退到未经用户选择的完整压缩。

## 迁移计划

1. 先新增两个 token 配置和摘要调用选项，使中段算法可以使用预算。
2. 重写中段选择、序列化、提示词和原子提交逻辑，并迁移 `/compact` 与 Token 水位调用测试。
3. 删除异步完整 Checkpoint 调用链、提示词常量、会话状态、持久化字段和上下文注入。
4. 更新三个 capability 的现行测试与配置示例，执行定向测试、全量类型检查和 OpenSpec 校验。
5. 部署后旧 session JSON 中的 `checkpointSummary`、`recentFiles` 字段作为未知字段被忽略；下一次保存自然清除，无需脚本。

回滚时需要同时恢复旧配置字段、会话状态和 ContextAdapter 参数，不能只恢复 handoff 文案；否则旧 Checkpoint 没有生成或注入入口。

## 待确认问题

无。默认预算采用最多 4 个用户轮次、尾部 8000 tokens、摘要输出 4096 tokens；若实际模型数据表明需要调整，使用现有环境变量配置机制修改，不改变本次架构边界。
