## 1. 扩大消息保留窗口与状态追踪机制

- [x] 1.1 修改 [CompactionService.ts](file:///d:/projects/MyAgent/src/core/usecases/CompactionService.ts#L20) 中的 `compactionRetainCount` 默认值， 将其从 4 扩大到 8。
- [x] 1.2 重构 [CompactionService.ts](file:///d:/projects/MyAgent/src/core/usecases/CompactionService.ts#L129) 中的文件收集器， 将 `collectReadToolFilePaths` 升级为 `collectRecentFileOperations`， 扫描历史消息时分别识别只读工具调用 （如 `readFile`） 标为 `read`， 识别写工具调用 （如 `editFile`、 `applyPatch`） 标为 `edit`， 返回包含路径和状态的数据数组。

<!-- checkpoint: npm run build -->

## 2. 修复 Windows 路径拼接与类型级联重构

- [x] 2.1 修改并更新 `recentFiles` 的数据结构类型定义为 `{ filePath: string, opType: 'read' | 'edit' }[]`， 同步重构以下位置的类型：
  - [context.ts](file:///d:/projects/MyAgent/src/core/domain/context.ts#L46) 中的成员变量 `recentFiles` 以及 `getRecentFiles` 和 `setRecentFiles` 的签名。
  - [ContextAdapter.ts](file:///d:/projects/MyAgent/src/ports/driven/ContextAdapter.ts#L29) Port 接口定义中的 `recentFiles` 签名。
  - [ContextRepository.ts](file:///d:/projects/MyAgent/src/core/usecases/ContextRepository.ts#L41) 内部 `recentFiles` 的序列化与反序列化逻辑。
  - [DefaultContextAdapter.ts](file:///d:/projects/MyAgent/src/adapters/context/DefaultContextAdapter.ts#L40) 中的 `assemble` 接口入参类型。
- [x] 2.2 修改 [CompactionService.ts](file:///d:/projects/MyAgent/src/core/usecases/CompactionService.ts#L98) 中 `triggerAsyncCompactionIfNeeded` 调用文件收集器及存储的路径， 确保其收集的文件路径转换为相对于当前工作区根目录的相对路径。
- [x] 2.3 重构 [DefaultContextAdapter.ts](file:///d:/projects/MyAgent/src/adapters/context/DefaultContextAdapter.ts#L62) 内部文件路径定位， 移除 `join(process.cwd(), filePath)`， 使用跨平台安全的相对路径转换， 彻底解决 Windows 下路径拼接 Bug。

<!-- checkpoint: npm run build -->

## 3. 实现工具内联计算并返回 Diff Hunks

- [x] 3.1 修改 [file-system.ts](file:///d:/projects/MyAgent/src/adapters/tools/tools/filesystem/file-system.ts#L411) 中的 `EditFileTool.execute`， 在写入成功后， 增设内存极简 Diff 比对逻辑， 在返回字符串尾部追加轻量级 Hunk 摘要。
- [x] 3.2 修改 [apply-patch.ts](file:///d:/projects/MyAgent/src/adapters/tools/tools/filesystem/apply-patch.ts#L102) 中的 `ApplyPatchTool.execute`， 在写入/修补成功后， 在返回字符串尾部追加 Diff Hunks。 在 strict 模式下若 `patchContent` 原始补丁过大， 需进行轻量化行级裁剪限制， 仅截取变动的 Hunks 片段， 避免 Tool Result 膨胀。

<!-- checkpoint: npm run build -->

## 4. 废除全文重载并装配文件状态清单

- [x] 4.1 重构 [DefaultContextAdapter.ts](file:///d:/projects/MyAgent/src/adapters/context/DefaultContextAdapter.ts#L58-L88)， 移除读取物理原文并注入 `<transient_file>` 的逻辑。
- [x] 4.2 在 [DefaultContextAdapter.ts](file:///d:/projects/MyAgent/src/adapters/context/DefaultContextAdapter.ts#L90) 系统头部拼接处， 新增装载 `<recent_files_inventory>` 标签， 列出文件相对路径和操作状态。 需显式建立映射关系： 将 `'read'` 转换为前缀 `[READ]`， 将 `'edit'` 转换为前缀 `[EDITED]`， 格式如 `[READ] path` 与 `[EDITED] path`。

<!-- checkpoint: npm test -->
