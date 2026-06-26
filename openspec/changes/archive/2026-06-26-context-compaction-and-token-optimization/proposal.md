## 改造原因

大语言模型（LLM）的 Token 额度与 ReAct 推理效率密切相关。当前 MyAgent 系统的上下文管理组件存在两大设计缺陷：
首先，在历史消息提炼（Compaction）上采取了极度粗暴的硬截断，默认仅保留最后 4 条消息。这导致 Agent 极易在多步骤推理中“健忘”，难以保持长链路逻辑的连贯性。
其次，在上下文注入（DefaultContextAdapter）上采取了冗余的全量二次注回，将最近读写的 5 个大文件原文（高达 25,000 tokens）强行注入头部。这些文件其实早已作为 Tool Result 呈现在历史中，二次注入造成了极其严重的 Token 冗余与资费浪费。
同时，由于 DefaultContextAdapter 中存在相对与绝对路径混用的 Windows 平台路径拼接 Bug，导致物理全文加载其实一直失效，一旦该 Bug 修复，系统将瞬间面临 Token 爆仓风险。
因此，为了兼顾 ReAct 的长推理链路完整性与极致的 Token 开销控制，亟需重构上下文提炼和文件注入机制。

## 变更内容

本次变更将对 MyAgent 系统的上下文收缩与注入契约进行优化重构：
1. **扩大消息滑动窗口**：将 CompactionService.ts 默认的消息保留条数从 4 条扩大至 8 条（4 轮完整的 ReAct 交互），确保模型能保留充足的近期上下文。
2. **废除物理全文二次注入**：DefaultContextAdapter 将废除在 System Prompt 之后读取并注入 recentFiles 全量物理原文的逻辑，避免成倍的 Token 重复浪费。
3. **引入状态清单与增量摘要**：在头部仅挂载包含路径及读写状态的 `<recent_files_inventory>`（例如 `[READ] src/index.ts`），并针对修改过的文件在工具执行成功后内联生成并携带轻量级 Diff Hunks 摘要，在不泄露 Token 的前提下保留变动感知。
4. **修复路径拼接 Bug**：修复 DefaultContextAdapter 中 `join(process.cwd(), filePath)` 的相对路径与绝对路径混用问题，实现稳健的跨平台路径定位。

## 业务能力

### 新增业务能力
- 无

### 修改业务能力
- `context-compaction`: 调整被压缩历史中最近消息窗口的保留上限，优化 Token 压缩与异步提炼触发逻辑。
- `context-adapter`: 废除大文件物理原文全量注入规则，修改为挂载文件读写状态清单以降低 Token 负载。

## 影响范围

- **受影响模块**：
  - `CompactionService.ts`：修改 `compactionRetainCount` 默认值，重构文件路径收集机制以区分读/写操作类型。
  - `DefaultContextAdapter.ts`：重构 `assemble` 逻辑，移除 `<transient_file>` 节点生成，新增 `<recent_files_inventory>` 节点装载，并修复绝对路径拼接 Bug。
  - `EditFileTool` 与 `ApplyPatchTool`：在文件编辑成功时，内联生成轻量 Diff 信息并追加到 Tool Result 返回体。
