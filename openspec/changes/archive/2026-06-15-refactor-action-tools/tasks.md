## 实施路径 (Execution Path)

- [x] 1. 创建底层防腐层目录 `src/action/native-tools`。
- [x] 2. 抽离基础设施服务：创建 `base.ts`，将 `authorizedDir` 的状态、`initWorkspace` 延迟初始化方法以及最核心的 `secureResolvePath` 隔离入此文件。
- [x] 3. 抽离文件系统 I/O 模块：创建 `file-system.ts`，迁入 `readFileTool` (包括对应的内存状态 `readFileState`)、`writeFileTool` 以及 `listFilesTool`，确保它们统一调用 `base.ts` 暴露出的 `secureResolvePath`。
- [x] 4. 抽离聚合搜索模块：创建 `search.ts`，将长达一百多行的 `grepSearchTool` 与 `globSearchTool` 剥离迁移。
- [x] 5. 组装入口与清理：重新整编 `src/action/tools.ts`，将其重写为一个轻量级的门面类（Facade），内部只做 `import` 与 `export` 转发，并保留 `toolsDefinition` 供 `virtual-mcp.ts` 调用。

<!-- checkpoint: npx vitest run test/action -q -->
