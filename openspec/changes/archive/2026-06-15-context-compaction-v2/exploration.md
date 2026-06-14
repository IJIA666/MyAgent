# 探索主题: 上下文裁剪与压缩机制现状分析 (Context Compaction)

## 1. 问题定义
当前 Agent 在运行过程中，当对话历史长度逐渐逼近模型上下文窗口的上限时，会触发上下文压缩（Compact）与会话物理轮换。
本次探索旨在深入剖析现有 `SessionManager.compact()` 机制的运作原理与潜在痛点，为下一步的重构或优化明确基准，暂不涉及外部竞品调研。

## 2. 关键发现与调研结果
- **触发机制**：
  在每次向 LLM 发送请求前，系统会预测组合后的 Token 数。当超过阈值（`getCompactionThreshold`，默认上下文上限的 75%）时，主动触发 `compact()` 方法。
- **物理隔离与防重机制**：
  采用文件锁（`.lock`）机制防止并发压缩，并设有熔断机制（连续失败 3 次即暂时放弃压缩，`compactionFailures >= 3`）。
- **历史提炼（Summarization）**：
  提取除首条 `system` 之外的所有历史记录（`fullHistory.slice(1)`），通过一个专门的 LLM 请求（`buildCompactionSummaryPrompt`）对其进行同步的摘要归纳。
- **记忆提取（File Pinning）**：
  遍历要丢弃的历史，提取大模型调用过 `readFile` 和 `writeFile` 的绝对文件路径（`collectReadToolFilePaths`），去重后作为“近期活跃文件”（`recentFiles`）保留。
- **物理会话轮换（Session Rotation）**：
  创建一个全新的 `SessionContext`（ID 为 `compact_${Date.now()}`），继承原有的 System Prompt，并将新摘要和活跃文件列表注入。同时将旧的 Session 快照持久化落盘，实现内存物理截断。
- **运行时状态重组（DefaultContextAdapter.ts）**：
  在发生请求时，组装器将新会话的摘要作为一条 `<conversation-checkpoint>` 的 `user` 角色消息前置插入；
  而提取到的 `recentFiles` 会被直接使用 `fs.readFileSync` **全量读取**，并包裹在 `<transient_file>` 标签下作为 `system` 消息紧跟其后注入。

## 3. 竞品预研深度核实：Claude Code 的神级解法

经过更深一步对 Claude Code 源码（`compact.ts`, `sessionMemory.ts`）的解剖，我们发现了他们在应对“上下文压缩”时的三把板斧，极其优雅地解决了我们的痛点：

### 斧头一：不跑路的指针级截断 (No Session Rotation)
- **发现**：正如之前确认的，他们完全不轮换 Session ID。所有记录（带有 UUID 和 parentUUID）都保存在同一个 JSONL 记录文件中。
- **收益**：大模型每次只需看到内存修剪后的 `messages` 数组，但物理日志始终连贯，随时可通过追溯 UUID 找回被折叠的历史。

### 斧头二：异步后台提炼，压缩零等待 (Asynchronous Session Memory)
- **发现**：我们之前痛点是“压缩时同步阻塞等待 LLM 读历史出摘要”（而且还要等到 75% 警戒线才开始）。Claude Code 的解法是利用 `registerPostSamplingHook` 在后台启动一个 **Forked Subagent（子 Agent）**。关键在于它的**触发时机**：它**并不是**等到上下文爆满时才去提炼，而是通过 `minimumTokensBetweenUpdate` 和 `toolCallsBetweenUpdates` 两个配置项，在用户日常聊天、Token 慢慢增长的过程中，**周期性地**在后台静默更新本地的 Markdown 文件（Session Memory）。
- **收益**：当主线程真的由于 Token 超载触发了上下文截断（Compact）时，系统根本不需要等，直接读取硬盘上**现成的** Session Memory 文件作为新对话的头部前缀，**瞬间完成截断，零耗时阻塞，用户体验极其丝滑。**

### 斧头三：带预算的文件状态重载 (Token-Budgeted File Pinning)
- **发现**：针对“记忆全量强塞导致二次爆仓”的问题，他们设计了极为严苛的重载护栏：
  1. **排除法**：如果某个文件在“截断后仍被保留的尾部消息”中已经存在，直接跳过不重载，避免浪费。
  2. **硬性预算 (Budget)**：全局限制只恢复最近的 5 个文件（`POST_COMPACT_MAX_FILES_TO_RESTORE = 5`），且这些文件的总占用不得超过 50,000 Token（`POST_COMPACT_TOKEN_BUDGET = 50_000`）。
  3. **单体截断**：单个被恢复的文件如果超过 5,000 Token（`POST_COMPACT_MAX_TOKENS_PER_FILE`），会在重新读取时被硬性截断。
     > **注（计算上的巧合/Bug）**：您可能发现了，5 个文件 × 5,000 Token/文件 = 25,000 Token，理论上永远触达不到 50,000 的总预算。这其实是 Claude Code 源码里的一处“防御性冗余配置”（可能是早期参数调整后遗留的，或者是给 JSON 包装结构留的极度宽裕的空间）。但它依然展示了这种**双层预算拦截**（单体限额 + 总体大盘限额）的设计思想。

### 补充核实：Opencode 的方案对比
应您的要求，我也对另一个标杆项目 `opencode` 进行了同等级的穿透调研（`packages/core/src/session/compaction.ts`）。
**结论是：它印证了我们的重构大方向，但在体验上不如 Claude Code 极致。**
- **同样不轮换 Session**：Opencode 也是在事件流里强行插入一条 `compaction` 类型的 Event/Message。下次发请求时，直接读这条总结，不物理切文件。
- **依然是同步阻塞**：与 Claude Code 丝滑的后台挂机提炼不同，Opencode 使用 `Effect-TS` 的 `yield* dependencies.llm.stream(...)` 进行了**同步的请求等待**，因此触发截断时用户仍然会卡顿。
- **简单粗暴的文件限流**：它没做 Claude Code 那种精细的文件重新读取（File Pinning），而是简单粗暴地写了一个 `truncate` 函数：在总结历史时，**把所有工具输出直接强行截断至 2,000 字符**（`TOOL_OUTPUT_MAX_CHARS = 2_000`）。这种做法虽然能防止爆仓，但很可能会把代码的核心逻辑给切没。

### 补充核实：Hermes 的方案对比
我同样深入调研了 `hermes-agent` 的实现（核心代码位于 `agent/context_compressor.py`）。
**结论是：它在“工程兜底”和“提示词结构”上做到了极致，但依然没能解决同步阻塞的痛点。**
- **同步阻塞与独立预算**：Hermes 也是在主流程里**同步等待**总结结果。但它引入了“辅助模型（Auxiliary Model）”的概念（默认配置为 `google/gemini-3-flash-preview`），让小模型专职做总结，避免占用主模型的并发限额。
- **渐进式总结（Iterative Update）**：它会把上一次的旧总结和本次的新增历史一起发给模型（`PREVIOUS SUMMARY` + `NEW TURNS TO INCORPORATE`），这与我们设想的增量归纳非常吻合。
- **极其强悍的防崩溃兜底（Deterministic Fallback）**：这是 Hermes 最惊艳的设计（`_build_static_fallback_summary` 方法）。一旦大模型 API 故障或超时，它不会彻底罢工，而是**在本地用代码拼接出一个纯文本的结构化摘要**（提取出用过的工具、修改过的文件、提取出用户提问等），强制保证上下文被顺利截断，让会话能继续下去！
  - **深度思考：兜底的真正意义**：如果只是因为断网，这种兜底确实毫无意义（因为主模型也会因为断网而无法发请求）。Hermes 的这个设计实际上是为了应对**“死锁变砖”**场景：当主模型网络完全正常，但辅助总结模型却因为安全审查拦截（Content Filter）、账号欠费、并发限流，或者历史记录中存在导致模型崩溃的“毒性 Token”，从而**永远无法总结成功**时。如果不强行用静态字符串截断历史，用户的上下文会永久卡在 100% 爆仓状态（`context_length_exceeded`），整个长会话就会彻底作废。这把“本地兜底手术刀”是在极端情况下的保命机制。

### 补充核实：OpenClaw 的方案对比
基于您的建议，我也横向穿透了 `openclaw` 的源码（核心位于 `src/agents/compaction.ts` 和 `compaction-safeguard.ts`）。
**结论是：它依然采用了主流程事件拦截（`api.on("session_before_compact")`）的同步阻塞模式，但在细节控制上有三个值得我们关注的闪光点：**
1. **多线程卸载 Token 计算**：在上下文快爆仓时，计算海量文本的 Token 并进行拆分（Chunking）是非常耗费 CPU 的。OpenClaw 使用了 Node.js 的 **Worker 线程**（如 `buildStageSplitPlanWithWorker`）来做分块计算，从而避免了主事件循环被卡死（防止界面假死）。
2. **极度苛刻的标识符保护（Identifier Preservation）**：它在提示词里硬性规定 `identifierPolicy: "strict"`，强制大模型**绝不可缩写或重构**任何 UUID、IP、端口、URL 和文件路径。这对于防范“总结完之后代码跑不通了（因为变量名被 LLM 简写了）”非常有效。
3. **“交接班”提示词（Handoff Instructions）**：这是极其巧妙的设计！如果在压缩的同时发生了模型切换（比如从 Claude 切换到了 GPT-4），它的压缩提示词会特化成一份**“恢复简报（Recovery Briefing）”**，并在提示词里严格申明层级：`"The new model is the LEADER... Identify autonomous units as SUBORDINATES"`，确保新模型接手后不会角色错乱。

## 4. 落地折中方案探讨：如何平替“后台子代理（Subagent）”？
由于 MyAgent 目前尚未构建完整的 Subagent（子代理）调度框架，强行引入会极大增加当前阶段的工程复杂度。针对“异步 Session Memory 提炼”，我们提出以下折中方案：

**推荐方案：轻量级后台异步 Promise（无工具调用的裸 LLM 请求）**
- **原理**：Session Memory 的提炼本质上是一个“纯文本进 -> 纯文本出”的归纳任务，根本不需要复杂的 Tool Loop（工具循环）。
- **做法**：在主线程的流式回复结束后，触发一个**不阻塞主线程的悬挂 Promise（Background Worker）**。这个 Worker 直接将历史消息包装成一条简单的总结 Prompt，向 LLM 发起一次纯粹的 ChatCompletion 请求（禁用任何工具）。拿到返回的 Markdown 文本后，直接通过 `fs.writeFile` 覆写到物理文件（例如 `.myagent/sessions/memory.md`）中。
- **优势**：
  1. **零框架负担**：不需要设计复杂的 Agent 间通信（IPC）、状态隔离和生命周期管理。
  2. **完全解耦**：失败了也无所谓（大不了下次再提炼），不影响主流程。
  3. **无缝平替**：完美实现了 Claude Code 方案中“主线程不等待，压缩零耗时”的核心收益。

## 5. 约束、风险与未知项
在深入源码后，暴露出当前实现方式存在多个极为致命的风险和设计缺陷：
1. **记忆全量强塞（上下文爆炸的导火索）**：`DefaultContextAdapter` 会把之前读写过的 `recentFiles` 强行读取全量正文并作为前缀 `system` 消息塞入。如果之前模型读取的是一个超大文件（甚至只是通过 offset 读了一小段），压缩后整个文件依然会被**全量无条件**塞入新上下文，这可能导致新会话一建出来就立刻再次打爆上下文，形成“死循环”。这与我们刚刚完成的 Stub 缓存去重理念背道而驰！
2. **同步阻塞与用户体验灾难**：触发压缩时，必须同步等待大模型去通读并总结之前的冗长对话。这会导致触发压缩的那一轮交互响应极慢。
3. **角色语义污染**：生成的 Checkpoint 摘要被硬编码包装为一条 `user` 角色的消息，这可能会让大模型产生幻觉，误以为是用户自己发送了一段冷冰冰的“本段对话摘要”。

## 4. 推荐方向
鉴于当前只是查明了现状，明确了痛点，下一步必须引入业界标杆（如 Claude Code、Aider 等）的实现机制进行深度对标调研，看看他们是如何解决“压缩时如何继承记忆、如何防止文件暴增”这个难题的。
