## MODIFIED Requirements

### Requirement: 通配符模式匹配文件查找
系统虚拟 MCP Server 必须（MUST）对外暴露名为 `globSearch` 的工具，接收 `pattern` 通配符参数。

检索执行时必须（MUST）基于原生异步流式 API（`fs.promises.opendir`）遍历目录，严禁（MUST NOT）使用同步阻塞的目录加载。遍历时必须（MUST）读取全局与用户自定义配置的忽略目录，并在检测到该目录时直接执行前置剪枝，严禁（MUST NOT）对其执行下行深度遍历和递归查找。匹配定位出的文件列表必须输出为相对工作区的路径列表。检索结果数量应当有上限限制（如最多 100 条）以防刷屏。

#### Scenario: 使用通配符搜索特定文件
- **WHEN** 虚拟 MCP 接收到针对 `globSearch` 的调用，参数为 `pattern: "src/**/*.ts"`
- **THEN** 工具必须基于异步流式且经前置剪枝过滤的逻辑，返回匹配到的 TypeScript 相对路径文件列表，如 `["src/index.ts", "src/action/tools.ts"]`
