# virtual-mcp-server

## Purpose
提供进程内模拟 MCP 协议交互的基础设施层，消除本地工具与远端工具在架构上的调用差异。

## Requirements

### Requirement: 提供符合 MCP 标准的文件读写工具
系统必须内置一个虚拟的 MCP Server 抽象层，用来封装底层的文件系统操作（readFile、writeFile、listFiles）。它必须对外提供标准的 MCP `CallTool` 接口调用格式。

#### Scenario: 成功处理本地文件读取请求
- **WHEN** 虚拟 MCP 接收到针对 `readFile` 的标准的 JSON-RPC `CallToolRequest`
- **THEN** 该虚拟 Server 必须成功读取指定文件，并返回包裹在 `content: [{ type: "text", text: "..." }]` 结构中的 `CallToolResult`
