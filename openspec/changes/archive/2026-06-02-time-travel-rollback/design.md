## 背景

当前 `SessionManager` 在处理流式响应时，是一条直线运行到底的。由于引入了不断迭代循环的 ReAct 工具调用机制，如果大模型陷入了死循环，或者用户意识到之前的指令有误需要重新下发，目前的框架没有任何机制可以终止当前请求并丢弃这段错误的思考链。

## 目标与非目标

**目标:**
- 支持外部调用方（如终端层监听到用户干预时）打断正在执行的 Agent 推理流。
- 提供安全丢弃最近 N 轮次错误交互记录的能力（会话级 Context Rollback）。

**非目标:**
- 物理状态回滚（绝对不引入针对文件读写、第三方网络请求等副作用的 SAGA 事务撤销）。
- 基于大模型自动判断的回滚（回滚的发起权完全保留在框架调度层或真实用户侧）。

## 架构决策

- **阻断生成流 (AbortController)**: 
  在 `SessionManager` 每次向 OpenAI SDK 发起 `chat.completions.create` 请求时，动态挂载一个 `AbortSignal`。向外暴露 `abort()` 方法供入口层调用。一旦触发，即可从网络层强制掐断大模型的输出流。
- **上下文记忆弹栈 (History Truncation)**: 
  在 `SessionManager` 暴露 `rollback(turns: number)` 方法，利用 `splice` 操作将记忆数组截断。为了支持“连续回滚”与“任意回滚”，该接口不仅支持指定步数，且每次调用后都会保持底层状态的干净，允许无缝多次调用。
- **用户显式调用层 (Double ESC & Slash Command)**:
  - **双击 ESC 快捷键**: 在终端通过监听 `keypress` 事件捕捉双击 `Escape`。如果 AI 正在生成，双击 ESC 执行**打断 (Abort)**；如果 AI 处于空闲输入态，双击 ESC 会触发**防误触拦截 (弹出 `y/N` 确认提示)**，确认后执行**单步回滚 (`rollback(1)`)**。
  - **`/rollback N` 斜杠命令**: 辅助双击 ESC，允许用户通过 `/rollback 2` 这种显式指令一次性跨越多轮会话。
  - **沉浸式终端重绘 (Redraw History)**: 上述无论哪种回滚触发后，统一调用 `console.clear()` 擦除整个终端画面的残留，接着深度遍历 `messageHistory` 将剩下的有效上下文重新打印，实现视觉上绝对干净的“时光倒流”体验。
- **中断恢复状态 (Recovery State)**:
  抛弃复杂的错误隔离区。阻断发生后，抛出标准化的 `AbortError`，并清理当前尚未完整落盘的脏数据（例如工具碎片的累计池），让会话保持在干净的状态以迎接下一次 `chat()` 唤起。

## 风险与权衡

- **[Risk] 工具调用中途的阻断导致资源未释放**: 若正在等待 MCP Server 执行耗时操作时发生中止，主控流退出但远端 Server 可能仍在执行。
  → **Mitigation**: 权衡实现成本，当前阶段不向远端 MCP 传播 Abort 信号（因 MCP SDK 对中止支持有限），仅在 `SessionManager` 侧直接丢弃等待的 Promise 引用并放弃记录其结果。
- **[Risk] 越界回滚破坏 System Prompt**: 如果传入的回滚轮数过大，可能会连同大模型的初始角色设定一起截断。
  → **Mitigation**: 在执行 `rollback` 时设立安全底线，强制保留 `messageHistory` 中的系统设定层（如 index 0 甚至历史种子设定），确保不可逾越初始化边界。
