## 改造原因

当前上下文压缩同时维护两套相互冲突的语义：Token 超限时执行首尾双保的中段压缩，回合结束后又异步生成完整历史 Checkpoint，并在每次请求前注入 `HANDOFF_INSTRUCTION`、最近文件清单和静态兜底摘要。后者不仅重复消耗模型调用，还会把历史摘要包装成“LEADER / SUBORDINATE”角色关系，使旧任务重新获得指令语义；固定简体中文、绝对标识符禁令和空泛静态兜底也与当前提示词简化方向不一致。

中段压缩本身仍按固定用户轮数选择尾部，没有 token 预算。当最近 4 轮包含较大工具结果时，受保护尾部可能占用过多上下文；同时摘要输入只记录工具名称而遗漏调用参数，摘要失败后还可能用缺少有效历史的静态文本替换中段。现在需要将压缩收敛为一套可解释、原子且与真实上下文边界一致的中段策略。

## 变更内容

- 将上下文压缩收敛为唯一的首尾双保中段压缩：头部只保护连续 system 前缀，工具列表仍作为独立请求字段保留；尾部最多保留最近 4 个完整用户轮次并受独立 tail token 预算约束，至少保留最近一个完整用户轮次，不切断 assistant `tool_calls` 与对应 tool result。
- 将压缩提示词改为“历史中段参考摘要”协议，只保留历史背景、约束、完成结果、关键决定、片段结束状态、错误结论和必要资源；明确后续保留原文优先，不生成当前任务、待办或下一步，不强制简体中文。
- 摘要序列化补齐 assistant 工具调用的名称与参数，并保留已经过工具输出 offloading 处理的 tool result 内容，使必要的文件路径、命令、错误和标识符确实进入摘要输入。
- 删除独立的绝对标识符禁令、角色晋升式 handoff 和静态伪摘要；标识符精确保留、会话语言、敏感凭据脱敏与禁止虚构统一进入中段摘要协议。
- 压缩采用原子提交：摘要为空、模型调用失败、无法形成安全中段或无法保持完整轮次时，不修改会话历史并返回失败；不得以无有效历史的兜底文本强行丢弃中段。
- **BREAKING** 删除回合后异步完整 Checkpoint 提炼、Checkpoint/recent-files 会话状态与请求头部注入，以及仅为该路径服务的 `AGENT_COMPACTION_TRIGGER_DELTA`、`AGENT_COMPACTION_FAILURE_LIMIT`、`AGENT_COMPACTION_RECENT_FILES_LIMIT` 配置。
- 保留 `AGENT_COMPACTION_RETAIN_COUNT` 作为尾部最多保留的用户轮数（默认 4），新增 `AGENT_COMPACTION_RETAIN_TOKENS` 作为尾部 token 预算（默认 8000），并新增 `AGENT_COMPACTION_SUMMARY_MAX_TOKENS` 约束摘要模型输出（默认 4096）；工具大输出仍由现有 tool-output-offloading 能力在进入历史时处理，中段压缩不二次破坏近期原文。

## 业务能力

### 新增业务能力

无。

### 修改业务能力

- `context-compaction`: 从“中段压缩 + 异步完整 Checkpoint”双轨策略收敛为 token 预算约束下的首尾双保中段压缩，并重写摘要、失败和轮次完整性契约。
- `config-runtime-limits`: 调整压缩运行参数，新增尾部与摘要输出 token 预算，并删除完整 Checkpoint 专用限额。
- `context-adapter`: 删除 Checkpoint、角色 handoff 与 recent-files 头部注入，只保留真实会话历史和当前有效的动态上下文组装。

## 影响范围

- 核心压缩与提示词：`src/core/usecases/brain/CompactionService.ts`、`src/core/usecases/brain/prompts.ts`。
- LLM 摘要调用：`src/ports/driven/llm/LlmPort.ts`、`src/adapters/llm/OpenAiLlmAdapter.ts`。
- Token 预算与触发：`src/core/usecases/plugins/TokenWatermarkPlugin.ts`、`src/core/usecases/engine/session.ts`、`src/core/usecases/engine/agent-loop.ts`。
- 上下文和持久化：`src/core/domain/context.ts`、`src/core/usecases/brain/ContextRepository.ts`、`src/adapters/context/DefaultContextAdapter.ts`、`src/core/usecases/engine/model-request-assembler.ts`、`src/ports/driven/session/ContextAdapter.ts`。
- 配置：`src/config/types.ts`、`src/config/loader.ts`、`.env.example` 及测试 mock 配置。
- 测试：压缩服务、Token 水位、提示词、上下文适配器、配置加载、会话持久化及模型请求组装相关测试。
- 不新增第三方依赖，不移动 `openspec/explorations/system-prompt-competitive-research.md`。
