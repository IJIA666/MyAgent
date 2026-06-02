## 1. 抽取 Tool Registry

- [x] 1.1 创建 `src/toolRegistry.ts` 文件，定义 `ToolRegistry` 类。
- [x] 1.2 在 `ToolRegistry` 中实现注册、查找、调用工具的核心逻辑，统一封装实际的 MCP Client 与虚拟 MCP 工具。
- [x] 1.3 从 `src/session.ts` 构造函数和原有逻辑中剥离底层 MCP 及文件工具的直接管理代码。

<!-- checkpoint: npm run build -->

## 2. 重构 SessionManager 为事件流引擎

- [x] 2.1 在 `src/session.ts`（或独立文件）中定义标准的 `AgentEvent` 类型集合（如 ContentEvent、ThinkingEvent、ToolCallEvent 等）。
- [x] 2.2 将 `SessionManager.chat()` 的返回类型从 `Promise<void>` 变更为 `AsyncGenerator<AgentEvent, void, unknown>`。
- [x] 2.3 彻底剔除 `chat()` 内部的 `process.stdout.write`，所有交互改为使用 `yield` 抛出事件。
- [x] 2.4 将原有的工具调用执行逻辑重定向至通过外部传入或内部持有的 `ToolRegistry` 实例进行分发。

<!-- checkpoint: npm run build -->

## 3. 适配终端消费者 (index.ts)

- [x] 3.1 改造 `src/index.ts` 的命令交互循环，从直接 `await session.chat(...)` 变更为 `for await (const event of session.chat(...))` 消费事件流。
- [x] 3.2 在消费者端实现各事件类型的终端渲染逻辑，恢复原有的彩色输出、打字机动效和加载图标。
- [x] 3.3 验证整个流程，确保终端表现与重构前保持绝对的一致性。

<!-- checkpoint: npm run build -->
