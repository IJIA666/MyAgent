# 探索主题: 上下文压缩与大型工具输出离线机制

## 1. 问题定义
随着 ReAct 多轮会话的迭代以及大文本工具（如长文件查看、大目录分析）的调用，Agent 的工作上下文 Token 会呈现爆发式增长。这会导致大模型 API 响应延迟急剧增大、Token 计费成本直线上升，甚至直接突破模型本身的上下文窗口限制。本项目需要设计一套在极简架构下运作的上下文压缩与大文本工具输出拦截离线机制，同时保障前缀缓存（Prompt Caching）命中率以及防止重要代码记忆丢失。

## 2. 关键发现与调研结果
- **代码库现状**：目前 [SessionContext](file:///d:/projects/MyAgent/src/brain/context.ts#L87) 只提供了 `messageHistory` 的追加与回滚，尚无任何自动压缩与大文本截断防护。[DefaultContextAdapter](file:///d:/projects/MyAgent/src/brain/adapters/DefaultContextAdapter.ts#L8) 负责组装局部规则和临时技能，注入位置在最新的一条 user 消息之前，以保持 assistant 与 tool 消息的相邻性。
- **核实与洞察**：深入对标 7 个开源 Agent 源码层发现：
  1. **大文本处理**：`Codex` 原生提供中部截断算法，保留错误栈头部和输出尾部；`Gemini-CLI` 在 [summarizer.ts](file:///d:/projects/Agent/gemini-cli/packages/core/src/utils/summarizer.ts) 中对大文本进行同步 LLM 摘要以压缩 Token。
  2. **缓存保护**：`OpenCode` 的 [to-llm-message.ts](file:///d:/projects/Agent/opencode/packages/core/src/session/runner/to-llm-message.ts) 将压缩后的上下文包装为 `role: "user"` 消息的 `<conversation-checkpoint>` 追加在会话中部；`OpenClaw` 会倒序扫描 messages 精确挂载至多 4 个 `cache_control`。
  3. **记忆保全**：`Claude-Code` 的 [compact.ts](file:///d:/projects/Agent/claude-code-analysis/src/services/compact/compact.ts) 在压缩前通过 `collectReadToolFilePaths` 自动搜集近期读过的核心文件，在压缩后重新挂载，防止文件记忆丢失。
  4. **并发控制**：`Hermes-Agent` 的 [conversation_compression.py](file:///d:/projects/Agent/hermes-agent/agent/conversation_compression.py) 引入 Session 级锁并物理轮转 `session_id`。

## 3. 方案对比与推荐方向
在上下文管理与压缩的架构选型上，进行多维度方案对比：

| 评估维度 | 方案 A：直接修改头部消息 | 方案 B：尾部时序追加 + 动静分离 | 选型分析 |
| :--- | :--- | :--- | :--- |
| 缓存友好度 | 极低 ✗（完全击穿后续所有轮次缓存） | 极高 ✓（静态头部保持不变，保障 100% 缓存命中） | 方案 B 占优 |
| 会话稳定性 | 弱 ✗（可能导致大模型指令偏航） | 强 ✓（通过 XML 结构标记 Checkpoint 引导） | 方案 B 占优 |
| 实现复杂度 | 低 ✓（直接覆盖 messageHistory[0]） | 中 ✗（需要重构 SessionManager 组装逻辑） | 方案 A 占优 |
| 记忆完整度 | 弱 ✗（滑动窗口会导致当前文件遗忘） | 强 ✓（结合 collectReadToolFilePaths 自动搜载） | 方案 B 占优 |

**推荐路径**：
本方案决定采取 **“时序 Checkpoint 追加 + 物理会话轮转 + 自动记忆重建”** 的动静分离机制，具体路径如下：
1. **时序压缩注入**：放弃修改第 0 个 System 消息，将较早的历史提炼为摘要，作为 `role: "user"` 的 `<conversation-checkpoint>` 消息块插入滑动窗口的前端。
2. **自动记忆重建**：压缩触发时，自动扫描并提取被剔除历史中最近被 `view_file` 或 `write_to_file` 访问过的关键文件路径，将其内容作为附件在新会话中重新挂载（单文件限制 5k tokens 内，总计 50k tokens 内）。
3. **大文件截断与智能分页**：当工具输出超出 8000 字符时，采用本地离线落盘，且上下文只保留前 2000 和后 2000 字符，中间以占位符引导，并提供分页读取工具 `read_temp_file_by_lines` 供模型按需调阅，打破召回死循环。
4. **并发锁与熔断机制**：引入 Session 锁（Session-level Lock），在并发子代理场景下防范压缩分叉，并设定连续 3 次压缩失败熔断。

## 4. 约束、风险与未知项
- **首包延迟开销**：提炼摘要时会产生 1 次 LLM 同步调用，需要在压缩时采用轻量化/低延迟的 Utility 模型（如 Flash 或 GPT-4o-mini）以平摊响应延迟。
- **并发锁死锁风险**：需要确保 Session 锁具备自动过期和手动清理机制，防止 Agent 崩溃后死锁导致后续交互被无限阻断。

## 5. 否决方案
- **子代理独立记忆系统**：被否决。引入复杂的子代理协作会带来巨额的 API 调用开销与死锁风险。
- **粗暴直接截断历史**：被否决。不提炼摘要直接舍弃历史会导致 Agent 完全失去开发上下文和共识，引发严重幻觉。
- **直接修改历史首节点**：被否决。每次压缩均重写消息头部会彻底击穿前缀哈希，造成高昂的 Token 费用和高延迟。
