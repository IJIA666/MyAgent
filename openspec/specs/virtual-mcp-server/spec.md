# virtual-mcp-server

## Purpose
提供进程内 MCP 形状适配能力，并确保本地工具不再依赖 virtual-mcp 作为装配或执行中心。该规范要求本地与外部工具都进入统一权限网关，同时保留各自真实执行边界。

## Requirements

### Requirement: 提供符合 MCP 标准的文件读写工具
系统 MUST 内置一个虚拟的 MCP Server 抽象层，用来封装底层的文件系统操作（readFile、writeFile、listFiles）。它必须对外提供标准的 MCP `CallTool` 接口调用格式。
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

### Requirement: 本地工具唯一装配源
系统必须（MUST）确保 `ToolCatalog`、`ToolCallGateway` 与 `ToolExecutor` 在本地工具范围内只使用同一批工具实例和正式授权适配器，不得出现两套独立装配或权限路径。

#### Scenario: ToolRegistry 直接使用唯一装配源
- **WHEN** 系统完成初始化并构建本地工具运行时
- **THEN** `ToolRegistry` 必须（MUST）基于同一批本地工具实例构造 `ToolCatalog`、`ToolCallGateway` 与 `ToolExecutor`，不得先通过 `LocalFileSystemMcpServer` 注册再二次提取或授权同一批工具。

#### Scenario: 新增本地工具后统一可见
- **WHEN** 开发者将一个新的本地工具加入本地工具装配清单
- **THEN** 该工具必须（MUST）同时被 `ToolRegistry.getTools()` 暴露、被 `ToolRegistry.getTool(name)` 返回本地元数据，并可通过 `ToolRegistry.callTool` 正常执行，不得因双重装配遗漏任一入口。

### Requirement: 本地工具调用绕过 virtual-mcp 装配中心
系统必须（MUST）确保本地工具主执行链不再依赖 `LocalFileSystemMcpServer` 作为装配中心或调用路由中心，但所有真实调用仍必须经过统一 ToolCallGateway。

#### Scenario: 本地工具调用先经统一网关再进入 ToolExecutor
- **WHEN** `ToolCallOrchestrator` 通过 `ToolRegistry.callTool` 调用一个已注册的本地工具
- **THEN** `ToolRegistry` 必须（MUST）先将请求交给 ToolCallGateway 完成授权、ExecutionPlan 和 grant 消费，再由 ToolExecutor 执行；不得通过 `LocalFileSystemMcpServer.callTool()` 或直接 ToolExecutor 旁路。

#### Scenario: virtual-mcp 若保留则仅为薄适配层
- **WHEN** 仓库仍保留 `LocalFileSystemMcpServer`
- **THEN** 该类必须（MUST）只充当 MCP 形状适配层，内部目录与执行逻辑必须委托统一的本地工具运行时，不得自行维护独立的 `ToolCatalog` 与 `ToolExecutor` 实例来源。

### Requirement: 外部 MCP 工具继续通过 McpToolManager 边界接入
系统必须（MUST）保持外部 MCP 工具与本地工具的执行边界分离：本地工具由本地运行时执行，外部 MCP 工具继续通过 `McpToolManager` 调用。

#### Scenario: 未命中本地目录时回退到外部 MCP
- **WHEN** `ToolRegistry.callTool` 收到一个未在本地 `ToolCatalog` 中命中的工具调用，且系统已配置 `McpToolManager`
- **THEN** `ToolRegistry` 必须（MUST）先为该外部 descriptor 构造 MCP ToolAuthorizationAdapter 并经过 ToolCallGateway，再由授权后的执行计划调用 `McpToolManager.callMcpTool`；不得通过本地 virtual-mcp 包装层或直接远端调用旁路。
