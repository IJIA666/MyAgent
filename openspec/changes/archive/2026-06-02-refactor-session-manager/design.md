## 背景

基于 `openspec/explorations/low-cohesion-analysis.md` 的探索结果，当前 `SessionManager` 因为过度耦合了 LLM 引擎流、终端输出(`process.stdout.write`)、以及 MCP 工具管理，成为一个难以测试且不可复用的“上帝类”。我们需要参照行业标准（如 OpenClaw、Claude-Code），将大模型引擎、工具管理和通道渲染（UI）彻底解耦。

## 目标与非目标

**目标:**
- 将 `SessionManager.chat()` 改造成纯粹的 `AsyncGenerator<AgentEvent>` 流式事件生成器。
- 引入独立的 `ToolRegistry` 来抽象和管理底层 MCP 客户端（包括 Virtual MCP）。
- 重构 `src/index.ts` 成为消费者，专门处理事件的终端渲染（打字机效果、工具调用日志等）。

**非目标:**
- 改变现有的 MCP 协议和实际工具执行逻辑。
- 引入复杂的数据库持久化。
- 支持终端外的其他 UI 形式（本次仅仅是解绑，不提供新的 UI 渠道）。

## 架构决策

**决策 1: 采用 `AsyncGenerator<AgentEvent>` 作为事件流接口**
- **理由**：大模型的输出和工具调用是典型的流式过程，原先在回调或内部直接 `process.stdout.write` 破坏了封装。使用 `yield` 抛出标准化的 `AgentEvent`（如 `AgentMessageEvent`, `AgentToolCallEvent`, `AgentToolResultEvent`）可以让外部（`index.ts`）完全掌握渲染的主动权。
- **替代方案**：使用 `EventEmitter`。但 `AsyncGenerator` 搭配 `for await` 在处理按序到达的大模型打字机流时，语法更简洁直观，无需陷入回调地狱。

**决策 2: 引入独立的 `ToolRegistry`**
- **理由**：将原先在 `session.ts` 里的 `VirtualMcpClient` 和普通 `Client` 收集逻辑单独剥离，`SessionManager` 只需依赖 `ToolRegistry.callTool(name, args)` 及 `ToolRegistry.listTools()` 接口，无需再知晓工具究竟来自哪个 MCP 服务器。

## 风险与权衡

- **风险 1: 打字机流渲染体验下降** -> **缓解**：`index.ts` 必须小心处理 `AgentEvent` 尤其是分块（chunk）事件的打印时序，确保没有额外的换行符被插入，维持原有的用户体验。
- **风险 2: 工具鉴权丢失上下文** -> **缓解**：`ToolRegistry` 在注册 MCP Client 时，需维持与之前同样的配置读取逻辑，并保持对本地沙盒的权限继承。
