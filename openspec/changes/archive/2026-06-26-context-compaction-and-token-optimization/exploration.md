# 探索主题: MyAgent 上下文提炼裁剪低效与大文件原文 Token 冗余浪费设计方案

## 1. 问题定义

- **缺陷定位**： 分析 [CompactionService.ts](file:///d:/projects/MyAgent/src/core/usecases/CompactionService.ts#L60) 的硬截断策略， 发现其默认仅保留最后 4 条消息， 造成 ReAct 推理上下文出现严重断层。

- **冗余注入**： 分析 [DefaultContextAdapter.ts](file:///d:/projects/MyAgent/src/adapters/context/DefaultContextAdapter.ts#L58-L88) 发现， 其在头部强行注入最近读写的 5 个大文件原文 （最多 25,000 tokens）， 与 ReAct 历史中已存在的 Tool Result 产生严重内容冗余。

- **妥协设计**： 为了规避物理全文注入带来的潜在 Token 爆仓风险， 项目在设计上静态地将消息滑动窗口限死在极窄的 4 条， 这极大限制了 Agent 的历史记忆感知能力。

## 2. 竞品调研发现

- **切点判定**： 研究 openclaw 的 [compaction.ts](file:///d:/projects/Agent/openclaw/packages/agent-core/src/harness/compaction/compaction.ts#L388-L439) 发现， 其通过累加估算 Token 并寻找逻辑完整切点 （如 user 消息或 split turn）， 保留约 20,000 tokens 的高完整性 ReAct 历史， 废除了死板的条数截断。

- **迭代更新**： 分析 openclaw 的 [compaction.ts](file:///d:/projects/Agent/openclaw/packages/agent-core/src/harness/compaction/compaction.ts#L478-L515) 发现， 其通过 `UPDATE_SUMMARIZATION_PROMPT` 提示词， 增量地将新被裁掉的历史融合进旧 checkpoint summary 中， 以减少重做摘要的 Token 消耗。

- **操作提取**： 研究 openclaw 的 [compaction.ts](file:///d:/projects/Agent/openclaw/packages/agent-core/src/harness/compaction/compaction.ts#L693) 发现， 其在压缩时只提取被修改和读取的文件名 （readFiles, modifiedFiles）， 不再向 context 重新注入文件全文， 迫使模型通过 tool 自主读取。

- **自动阈值**： 研究 Claude Code 的 [autoCompact.ts](file:///d:/projects/Agent/claude-code-analysis/src/services/compact/autoCompact.ts#L225) 发现， 其引入 `AUTOCOMPACT_BUFFER_TOKENS` （约 13,000 tokens） 作为缓冲区， 超过阀值时动态触发 session memory 压缩或传统 compaction， 保护 context 窗口。

## 3. 设计方案对比

根据用户共识与设计需求， 对比以下三种上下文提炼方案：

| 评估维度 | 方案 A (现有机制) | 方案 B (推荐方案) | 方案 C (极简清单) |
| :--- | :--- | :--- | :--- |
| **滑动窗口设计** | 固定 4 条消息极窄窗口 | 扩大到 8-12 条消息（或 Token 水位滑动） | 扩大到 8-12 条消息 |
| **文件注入内容** | 重新注入 5 个文件物理全文 | 注入轻量增量 Diff 摘要 + 读写状态清单 | 完全不注入文件内容，仅注入状态清单 |
| **Token 损耗水位** | 极高 (每轮最高 2.5W 冗余) | 极低 (仅有微量摘要与 Diff 字符) | 最低 (近乎为 0) |
| **历史动作感知** | 极弱 (丢弃 4 条前所有思考) | 极强 (保留最近大轮次 + 迭代 Checkpoint 摘要) | 较强 (保留最近大轮次，不保留摘要) |

## 4. 方案 B 核心设计细节

- **窗口参数**： 修改 `CompactionService.ts` 的 `compactionRetainCount`， 其默认值从 4 扩大到 10 条消息， 保留最近 5 轮高完整性的 Tool 调用与 ReAct 思考过程。

- **状态清单**： 在 `SessionContext` 中保存文件操作清单 （File Operations Inventory）， 格式为 `<recent_files_inventory>`， 包含被读写的文件相对路径及状态 （例如 `[READ] src/index.ts`、 `[EDITED] src/utils.ts`）。

- **增量摘要**： 废除 `DefaultContextAdapter.ts` 对 `recentFiles` 物理全文的二次注入， 改为在头部挂载 `<recent_files_inventory>`。 为规避 `git diff` 外部依赖， 将修改文件的 Diff 摘要生成时机前置到 `FileEditTool` 写入成功后， 由工具利用内存数据直接生成少量变更 Hunks 并推入上下文。

- **提炼触发**： 保留原有的 `triggerAsyncCompactionIfNeeded` 机制， 在累积 token 差额触发提炼后， 使用大模型更新 `checkpointSummary`， 保证被硬截断的 10 条以前的历史能被结构化记录。

## 5. 代码已存 Bug 披露

- **路径混用**： 分析发现 `DefaultContextAdapter.ts` 在 L62 使用了 `join(process.cwd(), filePath)`， 但 [CompactionService.ts L141](file:///d:/projects/MyAgent/src/core/usecases/CompactionService.ts#L141) 返回的 `filePath` 已经是绝对路径。

- **系统差异**： 该相对与绝对路径的混用， 导致在 Windows 系统上拼接出类似 `d:\projects\MyAgent\d:\projects\MyAgent\src\...` 的非法路径， 导致 `existsSync` 恒返回 `false`。

- **爆仓掩盖**： 此 Bug 导致 Windows 用户在运行时， 物理全文注入逻辑实际上被完全绕过， 从而在测试中“掩盖”了本该发生的 Token 爆仓问题。

## 6. 约束与未知风险

- **读取频次**： 完全移除全文注入后， 若 Agent 需要获取之前读过但已被截断的历史文件全文， 可能会增加 `view_file` 工具的调用频次， 产生额外的 Tool 轮数开销。

- **模型依赖**： 若大模型对 Diff 摘要的理解不够精细， 可能在定位复杂逻辑时出现细微偏差， 需要通过优化提示词确保 Diff 摘要的精准性。

- **竞态风险**： `isCompacting` 标志目前以单线程内存锁运行， 若未来引入多 Worker 线程， 该内存同步锁将失效， 需要采用原子标志或锁机制重构。
