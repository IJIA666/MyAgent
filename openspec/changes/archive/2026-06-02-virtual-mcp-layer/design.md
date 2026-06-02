## 背景

目前的 `simple-agent-core` 引擎（核心入口为 `src/session.ts`，工具定义在 `src/tools.ts`）在执行文件读取、写入和列表操作时，直接调用了 Node.js 宿主的 `fs` 模块。同时，我们的系统在 `McpToolManager` 中支持连接外部的 MCP 服务器。这就导致了工具生态在调用方式上被割裂成了“本地函数调用”与“远端 MCP RPC 调用”两套平行体系。为了长远的跨端演进与协议统一，我们需要在保留“开箱即用”的同时，消除这层硬耦合。

## 目标与非目标

**目标:**
- 将 `src/tools.ts` 抽象为一个实现了 MCP 协议规范的 `VirtualMcpServer`。
- 重构 `SessionManager`（`src/session.ts`），将对内置工具的特殊处理分支移除，将其视为普通的 MCP 节点。

**非目标:**
- **不在真实子进程中运行该内置 MCP Server**。它仅在逻辑抽象上是一个 Server，实际运行仍在主进程/主线程内存中，以消除 IPC 性能损耗并降低启动复杂度。

## 架构决策

- **Decision 1: 内存级虚拟化 MCP (In-Memory Virtual MCP)**
  我们引入一个 `LocalFileSystemMcpServer` 类，它内部封装了目前的 `readFile`, `writeFile`, `listFiles` 逻辑，对外暴露符合标准 MCP 协议的 `callTool` 接口（接收 JSON-RPC 请求，返回对应的 JSON-RPC 响应）。
- **Decision 2: 统一的 Tool Registry**
  原先 `getAllTools()` 会硬编码拼接本地工具。改造后，`SessionManager` 启动时会在内存中直接实例化并“连接”这个虚拟 MCP Server，把它的工具无缝合并进工具池。
- **Decision 3: 短路执行 (Short-circuit Execution)**
  为了性能，虚拟 MCP 层不会经过实际的 STDIO 管道序列化/反序列化，而是直接在内存中传递和解析请求/响应对象。

## 风险与权衡

- **风险 1**: 在封装为虚拟 MCP 协议后，请求与返回数据的结构会发生变化（如包裹在 `content[0].text` 中），若不仔细调整，可能导致大模型解析工具结果失败。
  **缓解措施**: 严格遵循官方 MCP `CallToolResult` 的 schema 返回数据。
