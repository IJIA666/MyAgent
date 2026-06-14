# 架构设计: 重构 Native Tools

## 1. 模块化拆分方案

我们将把原先的 `src/action/tools.ts` 实施“爆破”，并将其散落的代码以领域模型（Domain Model）的思想重构到 `src/action/native-tools/` 目录：

### 1.1 `src/action/native-tools/base.ts`
- **职责**：作为沙箱和环境配置的基石。
- **承载**：`initWorkspace()` 延迟初始化函数，以及防范目录遍历（Path Traversal）的 `secureResolvePath()` 安全解析函数。所有的下游原生工具在执行读写前，必须无条件调用此拦截器。

### 1.2 `src/action/native-tools/file-system.ts`
- **职责**：负责所有狭义上的直接文件 I/O 增删改查。
- **承载**：
  - `readFileState` 与 `readFileTool` (支持行号提取与基于 mtime 的去重拦截)
  - `writeFileTool` (全量写盘操作)
  - `listFilesTool` (目录树形结构拉取)

### 1.3 `src/action/native-tools/search.ts`
- **职责**：负责跨文件的内容嗅探与聚合查询。
- **承载**：
  - `grepSearchTool` (基于关键词或正则的并发文件行扫)
  - `globSearchTool` (基于 Glob 模式的模糊路径探照)

### 1.4 `src/action/tools.ts` (蜕化为入口路由)
- 原始文件将作为统一的对外聚合门面（Facade），仅仅负责通过 `import` 收拢上述子文件暴露出来的业务函数，并在这里进行统一的 `toolsDefinition`（Schema 定义）的合并。
- 这可以确保 `virtual-mcp.ts` 中对 `toolsDefinition` 和函数映射的调用完全零感知，不破坏现有的执行调度逻辑。
