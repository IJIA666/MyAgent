## 1. 基础契约抽象与工具类实现

- [x] 1.1 在 `src/action/virtual-mcp.ts` 中定义并导出标准的 `NativeTool` 接口契约。
- [x] 1.2 将 `readFileTool` 的实现合并重构为 `ReadFileTool` 类，消灭独立的物理函数。
- [x] 1.3 将 `writeFileTool` 的实现合并重构为 `WriteFileTool` 类，消灭独立的物理函数。
- [x] 1.4 将 `listFilesTool` 的实现合并重构为 `ListFilesTool` 类，消灭独立的物理函数。
- [x] 1.5 将 `loadSkill` 的实现合并重构为 `LoadSkillTool` 类，通过构造函数注入 `loadSkill` 回调依赖。
- [x] 1.6 将 `grepSearchTool` 的实现合并重构为 `GrepSearchTool` 类，消灭独立的物理函数。
- [x] 1.7 将 `globSearchTool` 的实现合并重构为 `GlobSearchTool` 类，消灭独立的物理函数。
- [x] 1.8 将 `executeCommandTool` 的实现合并重构为 `ExecuteCommandTool` 类，消灭独立的物理函数。

<!-- checkpoint: npm run build -->

## 2. 虚拟 MCP 服务器重构与测试验证

- [x] 2.1 重构 `src/action/virtual-mcp.ts` 中的 `LocalFileSystemMcpServer`，使用 `Map<string, NativeTool>` 动态注册表取代原本的 `switch-case` 硬编码分支。
- [x] 2.2 清理并修改 `src/action/tools.ts` 等导出，删除原有的旧物理工具函数导出。
- [x] 2.3 彻底重构 `test/action/tools.test.ts` 和 `test/action/terminal.test.ts` 等测试，改为实例化并测试对应的 `NativeTool` 对象。
- [x] 2.4 运行项目全量单元测试，确保测试 100% 通过且核心 ReAct 循环运转正常。

<!-- checkpoint: npm run test -->
