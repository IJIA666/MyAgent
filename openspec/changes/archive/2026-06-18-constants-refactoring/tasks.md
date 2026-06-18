## 1. ToolConstants 契约常量扩充

- [x] 1.1 修改 [constants.ts](file:///d:/Projects/MyAgent/src/common/constants.ts)，在 `ToolConstants` 类中新增三个缺失的本地内置工具名称常量：`LOAD_SKILL = 'load_skill'`、`GREP_SEARCH = 'grepSearch'` 和 `GLOB_SEARCH = 'globSearch'`。
- [x] 1.2 在 [constants.ts](file:///d:/Projects/MyAgent/src/common/constants.ts) 中，为 `ToolConstants` 补充三组静态只读别名判定数组（`TERMINAL_ALIASES`、`FILE_READ_ALIASES` 和 `FILE_WRITE_ALIASES`），将以前散落的硬编码别名全部移至其中。

<!-- checkpoint: npm run build -->

## 2. 本地工具声明与虚拟路由器重构

- [x] 2.1 修改 [tools.ts](file:///d:/Projects/MyAgent/src/action/tools.ts)，将 `toolsDefinition` 声明的各个工具配置中硬编码的 `name` 字段，全部替换为 `ToolConstants` 的引用。
- [x] 2.2 修改 [virtual-mcp.ts](file:///d:/Projects/MyAgent/src/action/virtual-mcp.ts)，将 `LocalFileSystemMcpServer.callTool` 内部 `switch` 语句中对内置工具名称的硬编码 case 字符串全量替换为 `ToolConstants` 的引用。
- [x] 2.3 修改 [mcp-client.ts](file:///d:/Projects/MyAgent/src/action/mcp-client.ts)，将其顶部防冲突校验的硬编码集合 `BUILTIN_TOOL_NAMES`（包含 `readFile`, `writeFile` 等）替换为通过 `ToolConstants` 的对应值构建。

<!-- checkpoint: npm run build -->

## 3. 安全拦截插件重构与测试回归

- [x] 3.1 修改 [HumanApprovalPlugin.ts](file:///d:/Projects/MyAgent/src/brain/plugins/HumanApprovalPlugin.ts)，移除局部的 `TERMINAL_TOOL_NAMES`、`FILE_READ_TOOL_NAMES`、`FILE_WRITE_TOOL_NAMES` 数组定义，并改写为对 `ToolConstants` 中定义的别名只读数组的直接调用。
- [x] 3.2 运行完整项目测试套件，执行回归测试，确保常量替换前后所有的安全拦截行为、物理越界判定均能够正常运作。

<!-- checkpoint: npm run test -->
