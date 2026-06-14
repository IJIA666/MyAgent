# virtual-mcp-server

## Purpose
提供进程内模拟 MCP 协议交互的基础设施层，消除本地工具与远端工具在架构上的调用差异。

## Requirements

### Requirement: 提供符合 MCP 标准的文件读写工具
系统必须内置一个虚拟的 MCP Server 抽象层，用来封装底层的文件系统操作（readFile、writeFile、listFiles）。它必须对外提供标准的 MCP `CallTool` 接口调用格式。
此外，虚拟文件系统在执行 `readFile` 时，必须（MUST）提供 JIT 伴生规范注入能力：顺着目标文件路径向上级目录递归寻找 `README.md` 或 `.cursorrules`，若找到，则读取并将其内容作为 `<system-reminder>` 后缀拼接在返回内容的尾部。
虚拟文件系统在执行 `readFile` 时，也必须（MUST）支持对任意文本文件按指定行范围分页读取，当接收到可选参数 `lineStart` 和 `lineEnd` 时，仅将指定区间的行内容返回给大模型。

#### Scenario: 成功处理本地文件读取请求
- **WHEN** 虚拟 MCP 接收到针对 `readFile` 的标准的 JSON-RPC `CallToolRequest`，且仅传入了 `targetPath`
- **THEN** 该虚拟 Server 必须成功读取指定文件的全部内容，并返回包裹在 `content: [{ type: "text", text: "..." }]` 结构中的 `CallToolResult`

#### Scenario: 成功按行范围分页读取文件内容
- **WHEN** 虚拟 MCP 接收到针对 `readFile` 的标准的 JSON-RPC `CallToolRequest`，其中 arguments 包含 `targetPath: "src/index.ts"`, `lineStart: 10`, `lineEnd: 20`
- **THEN** 该虚拟 Server 必须仅读取该文件第 10 到第 20 行（包含端点）的内容，并在输出的头部或元数据中标明总行数和当前读取范围，并将其返回给模型

#### Scenario: 本地文件读取触发 JIT 伴生规范自动注入
- **WHEN** 虚拟 MCP 接收到读取文件 `src/action/tools.ts` 的请求，且该文件的父级目录或根目录下存在 `README.md` 文件
- **THEN** 该虚拟 Server 在返回文件内容的同时，必须将该 `README.md` 的内容格式化为 `<system-reminder>` 标记块，并作为后缀自动追加在输出的 text 中返回给模型
