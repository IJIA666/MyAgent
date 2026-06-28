## 新增需求

### 需求: 工具去中心化配额差异化折叠 (Decentralized Tool Quota Pruning)
工具模块必须(MUST)在注册元数据中允许自定义 `maxLines` 和 `maxBytes`。当工具输出超出此配额时，系统必须(MUST)将完整输出同步写入本地外带目录，并在消息历史中记录为包含折叠预览与文件路径引用的复合结构。送大模型前，仅投递双向行级对折与字节保底对齐截断后的预览文本。

#### 场景: 工具输出超出配额触发外带裁剪
- **WHEN** 智能体运行 `search` 工具返回了超过 100 行的庞大文本，且 `search` 工具元数据中声明了 `maxLines` 为 50。
- **THEN** 系统立即将 100 行原始文本写入 `.myagent/tool-outputs/` 目录，并在内存消息历史中将其记录为复合结构，投递给大模型时的文本仅保留前 25 行和后 25 行，中间插入 `... output truncated; full content saved to [originalPath] ...` 占位，且会话物理日志中保留对该原始大文件的路径索引。

### 需求: 对抗 Lost-in-the-Middle 的首尾双保中段压缩 (Head & Tail Preserved Compaction)
当历史会话 Token 数量超限触发 Compaction 时，系统必须(MUST)对第一轮 Prompt 交互（System Prompt、用户首问及首个工具结果）和最近 $N$ 轮（默认 4 轮）的 Raw 交互进行强行保护不予裁剪，仅对处于两部分中间的“中段历史”进行 LLM 语义总结，并用一条 human 摘要消息将其替换。

#### 场景: Token超额时触发中段有损压缩
- **WHEN** 当前会话累积 Token 水平触发系统 Compaction 阈值。
- **THEN** 系统强行锁死 System Prompt 及最前一轮和最近 4 轮的原始对话块，仅将中段的所有交互（包括中间的大报错、海量工具过程）发送给 LLM 提炼为一段摘要，在内存中将中段整体替换为 `Summary Notice`，并将后续活跃运行的工具调用完整拼接在摘要之后。
