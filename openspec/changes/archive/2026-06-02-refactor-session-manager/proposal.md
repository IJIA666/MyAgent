## 改造原因

当前 `SessionManager.chat()` 方法存在严重的“上帝类”与“低内聚”反模式：它不仅承担了大模型的打字机流生成（LLM Chat Flow），还直接与终端的 `stdout` 输出强耦合，同时内部还硬编码了 MCP 服务的初始化与工具查找分发逻辑。
根据对 Claude-Code、Hermes-Agent、Tinypace-AI-Desktop 及 OpenClaw 等工业级 Agent 源码的深度探索，这种 I/O 耦合和工具路由内聚的设计会导致代码极难测试，并且完全无法在未来的桌面或网页 UI 中复用。因此，亟需重构，进行彻底的物理/逻辑隔离。

## 变更内容

- 剥离大模型引擎侧的所有 `process.stdout.write` 等直接 I/O 操作。
- 重构 `SessionManager.chat()` 方法，将其签名改为返回一个 `AsyncGenerator<AgentEvent>`，将事件流与呈现分离。终端打印交由 `src/index.ts` 消费者负责。
- **BREAKING**: 将所有的工具挂载与路由分发逻辑从 `SessionManager` 抽离，引入独立的 `ToolRegistry` 统一管理所有的 MCP 客户端和虚拟 MCP 工具。

## 业务能力

### 新增业务能力
- 无（纯架构重构）

### 修改业务能力
- `simple-agent-core`: 核心会话由命令式的 I/O 打印引擎重构为基于 `AsyncGenerator` 的事件流引擎，并且工具的装载由专门的 `ToolRegistry` 接管。

## 影响范围

- `src/session.ts`（重点重构）
- `src/index.ts`（需适配新的事件流消费与打印循环）
- 将新增 `src/toolRegistry.ts` 文件
