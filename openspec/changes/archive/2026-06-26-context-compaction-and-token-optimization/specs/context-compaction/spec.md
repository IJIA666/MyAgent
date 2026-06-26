# 业务能力: context-compaction

本规范定义了在上下文提炼与 Token 优化变更下， 针对 `context-compaction` 业务能力的增量需求修改。

## MODIFIED Requirements

### 需求: 无延迟指针级硬截断 (Zero-Latency Truncation)
系统必须在会话进行时提供指针级硬截断以防爆仓。 当消息历史数组长度超过保留阈值 （默认保留 8 条消息， 即 4 轮 ReAct 交互） 并且会话接近爆仓风险时， 系统必须瞬间执行指针级的消息截断， 直接读取硬盘现存最新的状态文件作为替换前缀。

#### 场景: 会话整体逼近物理 Token 警戒线
- **WHEN** 用户新问题发出前， 会话占用率预测达到物理总限额的 80%
- **THEN** 系统立即丢弃历史对话数组， 仅保留最近的 8 条消息作为安全水位线， 并在 System Prompt 头部注入最新的 `session_summary.md` 文本内容以及截断点后的残余原貌消息， 期间无需等待任何大模型即时响应

## REMOVED Requirements

### 需求: 核心文件绝对重载 (File Pinning)
**Reason**: 将最近读写的 5 个大文件物理原文以 `<transient_file>` XML 标签全量二次注入头部会造成极其严重的 Token 冗余， 消耗过高预算， 导致上下文管理机制失效。
**Migration**: 废除该绝对重载模式， 升级为 `文件清单与增量变更挂载 (File Operations Tracking & Diff Mount)`， 仅挂载包含相对路径和读写状态的清单， 并在文件被修改时携带由工具内联生成的 Diff 摘要。

## ADDED Requirements

### 需求: 文件清单与增量变更挂载 (File Operations Tracking & Diff Mount)
系统在进行上下文装配或截断重构时， 必须仅跟踪读写过的文件相对路径和操作状态挂载在提示词头部， 并在文件被编辑时携带轻量级 Diff 摘要， 不得将文件物理原文全量注入头部。

#### 场景: 头部挂载文件清单与编辑 Diff 摘要
- **WHEN** 装配大模型消息上下文或发生硬截断时
- **THEN** 系统必须在头部注入 `<recent_files_inventory>` 标签， 其内容仅列出最近读写过的文件相对路径和状态标识 （如 `[READ] src/index.ts`， `[EDITED] src/utils.ts`）
- **THEN** 当且仅当文件在会话中被编辑工具修改时， 由 EditFileTool （工具名 `editFile`） 与 ApplyPatchTool （工具名 `applyPatch`） 在写入成功后， 利用内存数据 （原内容与新内容） 计算轻量级 Diff Hunks 摘要附加在 Tool Result 返回体中， 而不得由 Compaction 过程或 ContextAdapter 去读取大文件物理全文注入
