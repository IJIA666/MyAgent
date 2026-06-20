## 改造原因

目前 `MyAgent` 已经为终端后台任务实现了 Stall Watchdog 卡死检测和 Watcher 日志匹配，但这些事件触发的异步 `onNotification` 通知目前仅仅是写入了宿主的控制台 stdout。
由于大模型在把任务丢入后台后（同步 resolved），整个智能体推理大循环（ReAct chat loop）已经终止并处于闲置等待状态，大模型在没有新交互的情况下根本无法感知到这些控制台输出，导致 Watchdog 的防卡死自救和 Watcher 的提前唤醒功能形同虚设。

为了闭环这“最后一公里”的异步唤醒链条，我们必须将这些后台事件投递通道打通至智能体的对话消息堆栈，并在智能体闲置时主动重新激活大模型的推理循环，从而真正实现端到端的自主异常恢复与事件唤醒。

## 变更内容

我们将打通终端后台任务的异步事件向大模型推理链路的闭环回传，引入以下能力：
1. **统一消息回流与 API 兼容包装**：在 `onNotification` 回调被触发时，自动将通知事件内容以 `role: 'user'` 消息形式（内容包裹在特定的 XML `<system_notification>` 标签中以作语义标识）灌入大模型的局部会话消息历史，避免破坏主流 LLM API 规范。
2. **事件总线设计**：扩展 `SessionContext`，让其具备基于事件发射器（`EventEmitter`）的 Pub/Sub 订阅能力，并在接收到后台事件时对外发布 `async_event`。
3. **外部隐式唤醒机制**：为 `SessionManager` 和外部 REPL CLI/测试驱动外壳连通订阅接口。当有积压的后台通知事件被注入且大模型正处于闲置状态（通过外壳推理繁忙状态判定）时，驱动外壳会自动且静默地启动新一轮的 `session.chat()`，拉起大模型以读取最新的系统通知并作出自主决策。

## 业务能力

### 新增业务能力
- `terminal-notification-loopback`: 提供后台任务事件（卡死/完成/匹配）自动灌入会话历史并自动触发拉起新一轮大模型推理循环的闭环唤醒能力。

### 修改业务能力
<!-- 无 -->

## 影响范围

- **代码层面**：
  - `src/brain/context.ts`：`SessionContext` 将引入 `EventEmitter` 的继承或包装，支持事件分发。
  - `src/action/tools/system/terminal.ts`：重构 `onNotification` 的内部动作，将其与 `SessionContext` 的消息注入和事件发布连通。
  - `src/brain/session.ts` / 驱动层：在 `SessionManager` 中为外部连通事件响应，打通空闲时重新调起大循环的能力。
