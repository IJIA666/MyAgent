## 背景

当前 `SessionManager` 类承担了从文件系统 I/O 落盘、OpenAI 请求驱动、DeepSeek 流式碎片重组，到 ReAct Agent 工具执行分发的所有工作。随着项目的演进，这个单一类已经变得异常庞大（400+ 行），任何对底层持久化机制或大语言模型协议的微调，都容易引发连锁反应并破坏现有的稳定性。

## 目标与非目标

**目标:**
- 将 `SessionManager` 的内部实现严格按照领域职责拆分，消除 God Class。
- 分离状态持久化层（`SessionContext`）与模型驱动层（`LlmDriver`）。
- 维持外部调用的接口兼容性（Facade 模式），使上游命令和 CLI 尽可能少做改动。

**非目标:**
- 不改变当前 Agent 核心的 ReAct 逻辑（保留原有的多轮工具调用循环机制）。
- 不更换持久化存储介质（目前依然保持 JSON 文件落盘，不在此次重构中引入 SQLite）。
- 不改变外部功能体验（自动补全、状态回滚等行为不变）。

## 架构决策

- **剥离 `SessionContext`**: 独立承接 `messageHistory` 的内存维护、`sessionId` 管理，以及 `.myagent/sessions/` 目录下的 JSON 读写落盘任务。
- **剥离 `LlmDriver`**: 独立承接 OpenAI client 的初始化、请求调度、流式遍历、特殊字段（`reasoning_content`）拦截。
- **重塑 `SessionManager`**: 退化为编排调度器。持有 `SessionContext`、`LlmDriver` 和 `ToolRegistry`，专门负责 ReAct 循环。

## 风险与权衡

- **接口平滑迁移风险**：`cli.ts` 等外部可能直接调用了 `session.getHistory()` 等接口。
  *应对方案*：`SessionManager` 继续暴露这些方法，内部通过代理直接转发给 `SessionContext` 实例即可，确保调用方零修改。
- **异常导致的数据截断**：网络异常中断可能导致上下文不同步。
  *应对方案*：在重构时，依然在 Catch 块与 finally 块中通知 `SessionContext` 进行 `saveState`。
