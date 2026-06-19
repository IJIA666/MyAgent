# 探索主题: 大循环骨架提炼与 Action 动态插槽重构 (Phase 2)

## 1. 问题定义
在第一期（Phase 1）重构完成状态容器与配置依赖注入解耦后，系统底座已经具备了极好的单元测试隔离性。但在进一步分析 `src/brain/agent-loop.ts` 和 `src/action/virtual-mcp.ts` 时，我们发现仍然存在两个制约系统扩展性与代码可读性的核心问题：
1. **核心 ReAct 引擎体量过重**：`AgentLoop.chat` 异步生成器长达 400 余行，强行在单一函数流中完成了：洋葱中间件（Hooks）的调度、LLM Stream 块解包、大文本拦截、本地/MCP 工具的反射调用、尾随工具判断和缓存失效击穿诊断。这导致大循环骨架不清晰，中途流式拦截修改非常困难。
2. **本地工具注册分派属于硬编码路由**：在 `LocalFileSystemMcpServer` (src/action/virtual-mcp.ts) 中，通过对工具名的巨大 `switch-case` 硬编码判断来路由并调用具体操作方法（如 readFile, writeFile, globSearch 等），违背了开闭原则（OCP），新增工具必须修改路由核心类。

---

## 2. 关键发现与调研结果
- **代码库现状**：
  - **`AgentLoop` (src/brain/agent-loop.ts)**：`chat` 循环中不仅有 Hooks 调用（如 `runHookPipeline`），还深度交织着 Stream 消费，甚至还要在同一个 `for await (const event of stream)` 里直接分派执行工具。
  - **`LocalFileSystemMcpServer` (src/action/virtual-mcp.ts)**：类内部通过导入的具体操作方法做 switch 派发。
- **核实与洞察**：
  - **ReAct 引擎优化路径**：
    1. **Hook 调度拦截器（HookRunner）**：提取 Hook 的触发、洋葱模型消费及 `abort` / `restart` 控制决策到独立类中，使 `AgentLoop` 仅发出“阶段信号”，不关心洋葱调度细节。
    2. **响应解包与状态处理（ResponseParser）**：把 Stream 输出的异步解包与用量（Usage）累加等操作提炼为无状态解析函数。
    3. **工具生命周期委托执行（ToolExecutor）**：将 `BeforeTool` -> `CallTool` -> `LargeOutputCheck` -> `AfterTool` -> `TailRequest` 这整条工具执行支流委托给专门的执行器。
  - **Action 动态插槽优化路径**：
    1. **多态插件契约**：定义 `NativeToolPlugin` 接口，各工具实现定义与执行方法。
    2. **插槽式 Registry**：`LocalFileSystemMcpServer` 成为动态持有者，通过 `Map<string, NativeToolPlugin>` 管理，彻底移除大 `switch-case`。

---

## 3. 方案对比与推荐方向

| 评估维度 | 方案 A (面向对象多态插槽 + 骨架提炼) | 方案 B (保持 switch-case，仅在 AgentLoop 内拆分子函数) | 结论 |
| :--- | :--- | :--- | :--- |
| **可维护性** | 极佳 ✓：新增工具只需实现接口并注册，不改核心；大循环仅为骨架，清澈见底 | 一般 ✗：新增工具仍需修改 switch 路由；AgentLoop 内拆分子函数依然存在高度耦合 | 方案 A 占优 |
| **开闭原则符合度**| 符合 ✓：本地工具完全多态插槽化，实现完全解耦 | 不符合 ✗：新增工具对 virtual-mcp 有修改侵入性 | 方案 A 占优 |
| **测试隔离性** | 极佳 ✓：各个本地工具可以脱离 virtual-mcp 进行 100% 独立行为测试 | 一般 ✗：测试工具必须通过虚拟服务器路由，无法直接测试特定工具实现 | 方案 A 占优 |

**推荐路径**：
选择**方案 A（面向对象多态插槽 + 骨架提炼）**。
- **重构步骤 1：Action 多态插槽化**：
  - 提取接口 `interface NativeTool`。
  - 将 `src/action/tools.ts` 中具体的业务工具重写为实现了该接口的实例。
  - `LocalFileSystemMcpServer` 改为通过 `register(tool: NativeTool)` 动态构建路由表。
- **重构步骤 2：AgentLoop 骨架解耦**：
  - 将洋葱 Pipeline 逻辑（含 abort/restart 状态翻译）独立封装。
  - 提取工具执行的完整子生命周期到 `ToolExecutor` 中。

---

## 4. 风险与未知项
- **异步控制流断裂与 Yield 穿透风险 (技术深坑)**：[AgentLoop](file:///d:/Projects/MyAgent/src/brain/agent-loop.ts#L57) 的 `chat` 方法是一个异步生成器（`AsyncGenerator`），它向外持续 yield 各种实时事件（如 chunk, tool_call_start, tool_call_result）。若将逻辑机械地拆分到普通类的普通方法中，子模块的状态变化将无法实时穿透到外层打字机视图。
  - **强制技术规范 (委托生成器)**：拆分出的子执行器（尤其是 `ToolExecutor` 和 `HookRunner`）的执行方法必须（MUST）也设计为异步生成器，并在主 [AgentLoop](file:///d:/Projects/MyAgent/src/brain/agent-loop.ts#L57) 中使用 `yield* toolExecutor.run(...)` 语法进行生成器委托，保障流式打字机效果及动态悬浮动画的无损穿透。
- **依赖引用循环**：在拆分 `ToolExecutor` 时，需要注意其引用的 `ToolRegistry`、`SessionContext` 以及 `ToolDispatcher` 的层级关系，严防引入包/模块的循环引用。

---

## 5. 否决方案
- **否决方案：将所有本地工具全部转化为真正的外部进程 MCP 服务器**：
  - *舍弃原因*：虽然这能实现最彻底的解耦，但会极大增加进程创建、TCP 通信与网络开销，破坏了项目“极简、高性能内嵌沙箱”的原则。必须坚持**进程内虚拟 MCP 模式**。
