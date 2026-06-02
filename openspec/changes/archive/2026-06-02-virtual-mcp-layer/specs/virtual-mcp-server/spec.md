## 新增需求

### 需求: 提供符合 MCP 标准的文件读写工具
系统必须内置一个虚拟的 MCP Server 抽象层，用来封装底层的文件系统操作（readFile、writeFile、listFiles）。它必须对外提供标准的 MCP `CallTool` 接口调用格式。

#### 场景: 成功处理本地文件读取请求
- **WHEN** 虚拟 MCP 接收到针对 `readFile` 的标准的 JSON-RPC `CallToolRequest`
- **THEN** 该虚拟 Server 必须成功读取指定文件，并返回包裹在 `content: [{ type: "text", text: "..." }]` 结构中的 `CallToolResult`
