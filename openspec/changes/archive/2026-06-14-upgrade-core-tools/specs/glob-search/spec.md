# glob-search

## Purpose
提供基于通配符的文件定位工具，辅助模型极速理清项目的物理文件布局，降低 Token 损耗。

## Requirements

### Requirement: 通配符模式匹配文件查找
系统虚拟 MCP Server 必须（MUST）对外暴露名为 `globSearch` 的工具，接收 `pattern` 通配符参数。工具必须根据该模式匹配定位项目中的文件，并输出以相对路径展示的文件列表。检索结果数量应当有上限限制（如最多 100 条）以防刷屏。

#### Scenario: 使用通配符搜索特定文件
- **WHEN** 虚拟 MCP 接收到针对 `globSearch` 的调用，参数为 `pattern: "src/**/*.ts"`
- **THEN** 工具必须返回匹配到的 TypeScript 相对路径文件列表，如 `["src/index.ts", "src/action/tools.ts"]`
