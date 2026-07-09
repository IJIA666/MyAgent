## 修改需求

### 需求: 虚拟 MCP 服务器收缩为协议适配层

系统必须继续内置一个虚拟的 MCP Server 抽象层，用来封装本地工具的 MCP 协议适配。该层对外继续提供标准的 MCP `CallTool` 接口调用格式，但其内部工具目录与执行逻辑应委托给拆分后的边界对象。

`LocalFileSystemMcpServer` 的内部工具目录与执行应（SHALL）委托给 `ToolCatalog` 和 `ToolExecutor`，自身收缩为 MCP 协议适配层，不再直接实例化内建工具或维护资源提取器。

#### 场景: 成功处理本地工具调用请求

- **WHEN** 虚拟 MCP 接收到任意已注册本地工具的标准 `CallToolRequest`
- **THEN** 该虚拟 Server 必须继续返回包裹在 `content: [{ type: "text", text: "..." }]` 结构中的 `CallToolResult`

#### 场景: MCP 工具列表委托给 ToolCatalog
- **WHEN** 虚拟 MCP 接收到 `tools/list` 请求
- **THEN** `LocalFileSystemMcpServer` 应委托 `ToolCatalog.getTools()` 获取工具列表，自身不再直接持有工具实例引用

#### 场景: MCP 工具调用委托给 ToolExecutor

- **WHEN** 虚拟 MCP 接收到 `tools/call` 请求
- **THEN** `LocalFileSystemMcpServer` 应委托 `ToolExecutor.execute()` 处理调用，自身不再内嵌工具执行分发细节
