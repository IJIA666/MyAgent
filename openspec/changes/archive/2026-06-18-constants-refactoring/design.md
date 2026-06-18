## 背景

项目目前在本地工具的调用、声明以及拦截判断（安全卡关）逻辑中，存在不少魔术字符串（如 `'load_skill'`、`'grepSearch'`、`'globSearch'`）和行内的工具名判定别名数组（如 `HumanApprovalPlugin.ts` 中的 `TERMINAL_TOOL_NAMES`、`FILE_READ_TOOL_NAMES`、`FILE_WRITE_TOOL_NAMES` 等）。这些魔术值的散乱硬编码不利于静态类型校验，容易在开发过程中因笔误引入隐蔽的安全卡关失效漏洞。

## 目标与非目标

**目标:**
- **消灭魔术字符串**：将散落在 `tools.ts`、`virtual-mcp.ts`、`mcp-client.ts`、`HumanApprovalPlugin.ts` 中与工具名称和别名相关的硬编码字符串，统一收拢到 `src/common/constants.ts` 的 `ToolConstants` 静态类中进行维护。
- **别名判定数组集中化**：将 `HumanApprovalPlugin.ts` 中的多组工具名称判定别名数组移至 `ToolConstants` 中集中管理，确保整个系统安全卡关别名判定口径的一致性。
- **保持运行时向后兼容**：本次常量的提取不能改变任何底层的字符串字面量值，必须保证运行时对原有工具行为和安全的无感知过渡。

**非目标:**
- **不进行全局配置体系的重构**：如 `openspec/explorations/config-and-constants-optimization.md` 所述，收拢全局 `process.env` 与 `loader.ts` 架构体系的改造，牵扯较多，定为远期演进目标，本次重构坚决不予执行。
- **不改变既有的白名单判定与物理沙箱逻辑**：本次仅改变工具名称常量及别名数组的定义位置和引用方式，不修改核心的安全判定策略和路径解析逻辑。

## 架构决策

- **扩展 `ToolConstants` 静态类**：
  在 `src/common/constants.ts` 中，为 `ToolConstants` 补充三个缺失的本地内置工具名称常量：
  - `LOAD_SKILL = 'load_skill'`
  - `GREP_SEARCH = 'grepSearch'`
  - `GLOB_SEARCH = 'globSearch'`
  并在类中新增三组静态只读数组以封装各工具分类的判定别名（使用 `as const` 锁定类型）：
  - `TERMINAL_ALIASES`：包含 `['execute_command', 'bash', 'run_command', 'sh', 'executeCommandTool']`
  - `FILE_READ_ALIASES`：包含 `['readFile', 'listFiles', 'read_file', 'list_files']`
  - `FILE_WRITE_ALIASES`：包含 `['writeFile', 'editFile', 'write_file', 'edit_file']`

- **重构调用方依赖**：
  - **工具声明层 (`src/action/tools.ts`)**：将 `toolsDefinition` 中各个内置工具的 `name` 属性由硬编码改为直接引用 `ToolConstants` 对应的静态常量。
  - **虚拟 MCP 路由器 (`src/action/virtual-mcp.ts`)**：将 `callTool` 中 `switch` 的 `case` 字符串字面量分支，修改为使用 `ToolConstants` 中的对应静态属性。
  - **MCP 客户端管理器 (`src/action/mcp-client.ts`)**：将顶部防冲突校验的硬编码 Set（`BUILTIN_TOOL_NAMES`）中包含的内置工具名硬编码全部替换为对 `ToolConstants` 的引用。
  - **人机协同审批插件 (`src/brain/plugins/HumanApprovalPlugin.ts`)**：将 `BeforeTool` 拦截网关中的局部硬编码数组别名直接指向 `ToolConstants` 中集中定义的只读别名数组。

## 风险与权衡

- **[风险点：字符串拼写不一致导致安全判定失效]** -> **[缓解策略]**：在提取和替换过程中，通过仔细核对 Git diff 以及运行现有的 Vitest 自动化单元测试，确保替换前后的字符串字面量绝对一致，特别注意大小写格式（如 `readFile` vs `read_file` 等）。
