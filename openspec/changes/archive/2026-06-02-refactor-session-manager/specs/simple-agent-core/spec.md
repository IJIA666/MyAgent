## ADDED Requirements

### Requirement: 事件驱动的核心会话流
系统的核心大模型调度引擎（如 `SessionManager`）必须（MUST）是一个纯粹的计算核心，通过 `AsyncGenerator<AgentEvent>` 的形式产出流式事件，而不能直接在内部执行 `process.stdout.write` 等具体的终端打印操作。终端交互层必须只作为消费者来处理这些事件，从而实现引擎与 UI 渠道的彻底解耦。

#### Scenario: 引擎产生流式事件并交由外部消费
- **WHEN** 大模型返回了一个打字机文本块（Content Chunk）或开始发起工具调用（Tool Call）
- **THEN** `SessionManager.chat()` 必须通过 `yield` 返回标准化的 `AgentEvent`（如包含类型为 `content` 或 `tool_call_start` 的事件对象），而具体的打印行为由外层的 REPL 循环完成。

## MODIFIED Requirements

### 需求: Agent 自动收集所有可用工具并调度
系统必须（MUST）通过一个专门的、独立于 `SessionManager` 的 `ToolRegistry` 来聚合和管理所有的 MCP 客户端和内置虚拟工具。`SessionManager` 不能再自行管理 MCP 连接或在内部进行工具映射，它只能通过调用 `ToolRegistry.callTool(name, args)` 来分发大模型发起的工具请求。

#### 场景: 发起对内部文件系统的 Tool Call
- **WHEN** 模型返回了一个 `tool_calls` 要求读取文件
- **THEN** SessionManager 必须将请求直接委托给 `ToolRegistry`。`ToolRegistry` 负责查找对应的内置虚拟 MCP Server 进行处理，并将标准结果返回给 SessionManager。
