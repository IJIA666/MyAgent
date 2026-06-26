## 背景

当前系统的上下文管理机制在提炼（Compaction）和装配（Adapter）上存在缺陷：
1. **截断策略硬伤**： [CompactionService.ts](file:///d:/projects/MyAgent/src/core/usecases/CompactionService.ts) 默认仅保留 4 条消息， 造成 ReAct 推理长链极易断裂。
2. **全文冗余注入**： [DefaultContextAdapter.ts](file:///d:/projects/MyAgent/src/adapters/context/DefaultContextAdapter.ts) 在 System 头部重复强行塞入 5 个大文件的物理原文 （最多 25,000 tokens）， 浪费了昂贵的 Token 资源。
3. **路径混用缺陷**： adapter 内使用 `join(process.cwd(), filePath)` 装配绝对路径文件， 在 Windows 平台拼出非法路径， 导致文件读取永久静默失效， 意外掩盖了 Token 爆仓的隐患。

## 目标与非目标

**目标:**
- **扩大消息窗口**： 将 `compactionRetainCount` 默认值扩大至 8， 保留最近 4 轮 Tool 调用与思考。
- **降级全文注入**： 废除最近大文件的物理原文注入， 改为在 System 头部仅挂载文件读写相对路径清单与操作状态。
- **操作类型追踪**： 重构 `CompactionService` 路径收集逻辑， 区分出文件是由读取工具操作 （`[READ]`） 还是由写入工具操作 （`[EDITED]`）。
- **类型级联重构**： 同步升级 `SessionContext`、 `ContextAdapter` 接口、 `ContextRepository` 及 `DefaultContextAdapter` 中 `recentFiles` 的数据结构类型， 确保类型安全。
- **前置 Diff 生成**： 在 `EditFileTool` 与 `ApplyPatchTool` 内部， 利用原内容与写入新内容的内存数据， 内联计算轻量级的 Diff 变化信息并附加在 Tool Result 返回体中， 避免对外部 Git 工具链的硬依赖。
- **修复路径拼接**： 重构 `recentFiles` 的路径定位与转换， 实现稳健的跨平台相对路径规范化， 彻底解决 Windows 下相对路径与绝对路径混用 Bug。

**非目标:**
- **不重构主控制流**： 本次重构不修改 ReAct 主决策推演的核心状态机和消息轮转控制逻辑。
- **不引入复杂滑动算法**： 暂不实现基于 openclaw 极其复杂的 Token 动态滑动及分片（split-turn）逻辑， 保持修改的低侵入性。
- **不干涉其它适配组件**： 排除对除上下文压缩与注入外其它模型驱动/生命周期管理适配组件的重构。

## 架构决策

- **决策 1**： 扩大默认保留消息窗口， 将默认 `compactionRetainCount` 提升至 8。
  - *原因*： 8 条消息 （4 轮 ReAct 交互） 能够在极低侵入性的前提下， 显著缓解 Agent 在多步骤定位中的“健忘”现象。

- **决策 2**： 头部仅装载文件相对路径与操作状态清单， 挂载为 `<recent_files_inventory>` 节点。
  - *原因*： 列出最近读写过的文件相对路径和操作状态 （如 `[READ] src/index.ts`， `[EDITED] src/utils.ts`） 足以帮助模型感知操作历史， 若需要全文可引导大模型自行调用 `readFile` 工具。 为了达成此设计， 将重构 `CompactionService` 对历史工具调用的扫描函数， 识别 `readFile`、 `editFile` 和 `applyPatch` 的行为并区分操作类型。

- **决策 3**： 将增量 Diff 摘要的计算时机前置到 `EditFileTool` 和 `ApplyPatchTool` 执行成功后。
  - *原因*： 这些编辑工具在写入成功时天然持有修改前后数据的内存 buffer， 在此时执行极简 Diff Hunks 提取比在 Compaction 阶段调用外部 `git diff` 脚本更加轻量且免去了外部 Git 工具的依赖。

- **决策 4**： 使用 `path.relative` 将搜集到的文件绝对路径全部规范化为相对于工作区根目录的相对路径。
  - *原因*： 解决在 Windows 平台下强行拼接 `process.cwd()` 与绝对路径导致的路径非法 Bug， 统一跨平台上下文中的文件格式。

## 风险与权衡

- **[风险点]** 废除全文物理注入后， 如果模型需要已被硬截断的文件全文， 可能增加 `readFile` 调用的频次， 增加 ReAct 工具轮数开销。
  - *缓解策略*： 通过向大模型注入 `<recent_files_inventory>` 帮助其合理评估文件可用状态； 同时将保留窗口从 4 扩大到 8 可降低频繁读取相同文件的概率。

- **[风险点]** 内存中内联计算 Diff 摘要可能给编辑工具带来一定的计算和代码复杂度。
  - *缓解策略*： 采用轻量且健壮的行级比对逻辑， 仅抓取修改行前后 3 行的变动 hunk， 不执行 AST 或大体量内容计算， 降低执行延迟与代码侵入。
