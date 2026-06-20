# 探索主题: 终端后台事件通知向 Agent 推理链路的异步唤醒打通

## 1. 问题定义
在当前的 `MyAgent` 重构设计中，终端执行引擎引入了异步后台长任务托管、Stall Watchdog 卡死监测以及带频控的 Watcher 行匹配机制。虽然这些机制能正确触发 `onNotification` 回调，但存在以下严重痛点：
- **消息对模型不可见**：`onNotification` 目前仅写入了宿主机的 `process.stdout`。一旦智能体单次推理大循环（ReAct chat loop）在 15 秒后转后台并 resolved 返回，大模型将处于“闲置”状态。大模型无法在后续的对话中看到此通知。
- **无法主动拉回注意力**：当后台任务在卡死（Stalled）或成功/失败（Completed）时，大模型不会被重新唤醒。必须依赖人类用户手动输入新的消息以拉起下一轮 `chat` 循环，这就割裂了“自动监测-自动响应”的主动闭环，使得 Watcher 和 Watchdog 的自动化价值有名无实。

本探索旨在探讨如何在 `SessionManager`、`SessionContext` 及外部 CLI 驱动循环中引入一种安全、非阻塞的消息队列与异步唤醒（Loopback）机制，使得后台事件在触发时能智能地灌入上下文并唤醒大模型。

## 2. 关键发现与调研结果

- **代码库现状**：
  - `src/brain/agent-loop.ts` 中的 `chat` 推理发生在一个流式异步生成器中，依赖 `driver.streamChat` 大循环。一旦 `hasToolCalls` 状态为 false 且没有待处理的工具，`chat` 即告 resolved 并终止。
  - `src/brain/session.ts` 中的 `SessionManager` 对 `AgentLoop` 执行被动包装，提供被动式的 `addUserMessage` 和 `chat` 驱动入口。其本身并没有活动的后台事件订阅和消费逻辑。
  - 所有终端进程工具均在 `SessionContext` 的局部上下文（由 `sessionId` 隔离）下运行，但 `SessionContext` 本身没有任何订阅/发布（Pub/Sub）或事件侦听设计。

- **核实与洞察**：
  - **Claude Code 源码实现分析 (`LocalShellTask.tsx` & `messageQueueManager.ts` & `useQueueProcessor.ts`)**：
    - **队列缓冲**：建立了一个模块级且独立于 React 状态周期的统一优先级指令队列 `commandQueue`，所有用户输入与系统事件通知均流经该管道。后台任务或卡死看守（Stall Watchdog）触发时，向队列调用 `enqueuePendingNotification` 注入最低优先级（`later`）的 XML 格式系统消息。
    - **自动消费与唤醒**：在 React Ink 的交互主循环中，通过 `useQueueProcessor` Hook 订阅了队列变动与大模型忙锁 `queryGuard`。一旦大模型进入闲置状态（`isQueryActive = false`）且队列中有积压通知，主循环会自动触发 `processQueueIfReady` 消费通知并调用 `executeQueuedInput`，直接把卡死警告灌给大模型做新一轮的 ReAct 推理，从而完成全自动唤醒。
  - **Hermes Agent 源码实现分析 (`process_registry.py`)**：
    - **统一事件总线**：在 `ProcessRegistry` 中，内置了一个标准线程安全队列 `completion_queue`，用来缓冲后台进程的退出事件与 watch_patterns 实时匹配命中的输出切片。
    - **事件循环 Drain**：在 CLI 的 REPL 大交互循环（`process_loop`）及 Gateway 流调度中，每个智能体交互回合（Agent Turn）结束的收尾阶段，均会执行排空（`drain`）该队列的动作。若检测到匹配，自动将事件信息重组并强制塞回输入源，自动拉起下一轮推理周期。
  - **OpenCode 源码实现分析 (`bash.ts`)**：
    - **同步挂起局限**：目前的 V2 核心 `bash` 模块仍不支持非阻塞的后台执行，采用传统的同步挂起阻塞与 timeout 保护（默认 2 分钟超时）。
    - **待办排期（Parity Debt TODO）**：在其源码的架构设计 TODO 列表中，已明确记录了“需要设计并重构出面向模型的异步启动，并包含完成通知投递机制（Re-add model-facing background launch only with completion delivery）”的长期演进目标。
  - **OpenClaw 源码实现分析 (`task-registry.ts` & `task-completion-contract.ts`)**：
    - **所有权与通道绑定**：在创建后台任务记录时，系统会为 `TaskRecord` 显式绑定调起该任务的 `requesterSessionKey` 与目标接收通道 `requesterOrigin`（如 `notifychat` 房间或会话线程 ID）。
    - **跨 Session 主动投递**：当任务状态发生改变或结束时，注册表通过 `maybeDeliverTaskStateChangeUpdate` 异步触发消息流转，从 `loadTaskRegistryDeliveryRuntime()` 中调用全局的 `sendMessage` 接口，将格式化后的完成总结或报错直接推送（Push）回原本的 Chat 线程。这种与聊天通道（Chat Channel）深度打通的动态消息推送机制，能够直接将后台结果以系统/用户消息形式回传，触发大模型进行后续的决策。

## 3. 方案对比与推荐方向

| 评估维度 | 方案 A: 会话消息队列注入 + 外部驱动异步唤醒 (推荐) | 方案 B: 终端工具同步化阻塞等待 | 方案 C: 客户端定时轮询状态 (Polling) |
| :--- | :--- | :--- | :--- |
| **核心机制** | 将事件作为带有特殊 XML 系统标签的 `user` 消息注入 Context，并利用 EventEmitter 触发外部驱动重新运行 `chat()` | 去除后台化，大长任务时强行同步阻塞，直到触发 pattern 或 exitCode | 客户端外壳定时调用 status 接口检测，发现变化时由客户端重新拉起 chat |
| **异步长跑支持**| 极佳 ✓（模型立刻返回闲置，后台长跑） | 极差 ✗（完全沦为前台阻塞，智能体死锁 30 分钟） | 较好 |
| **开发与调试成本**| 中等（需要改造 `SessionContext` 继承事件发射器） | 极低 ✓（只修改工具等待逻辑） | 中等 |
| **系统上下文一致性**| 强 ✓（通过原子锁防竞态，消息时序正确） | 弱（可能导致长时间挂起引发的 TCP 超时） | 中（可能有轮询延迟） |
| **推荐分析** | **方案 A** 最优，是生产级 Agent 系统的标准设计。 | B 失去了异步核心价值。 | C 有轮询开销和延迟。 |

**推荐路径**：
首选 **方案 A (会话消息队列注入 + 外部驱动异步唤醒)**：
1. **Context 引入事件发射器**：让 `SessionContext` 继承 `EventEmitter`，使其支持 `on('async_event', ...)` 事件订阅。
2. **通知入队列与入上下文**：修改 `terminal.ts` 中的 `onNotification`。在事件到达时，自动将格式化后的后台信息作为 `role: 'user'` 消息（使用如 `<system_notification>` 等明确的 XML 标签包围，以区别于用户的手动输入，同时保证消息流顺序的 API 合规性，防止被部分大模型 API 拒绝）调用 `sessionContext.addMessage(...)` 注入到会话历史中。
3. **连通驱动总线**：在 `SessionContext` 中触发该事件发射。外部 CLI 控制台或驱动宿主（例如 REPL 监听器）订阅该事件，一旦感知到 `async_event` 到达且当前会话没有处于 `isProcessing` 推理忙碌状态，便**立刻自动隐式执行 `for await (const event of session.chat())` 调起大模型**，从而实现大模型被异步自动唤醒，读取最新注入的后台卡死/完成系统消息并实施自我修复或下一步任务。

## 4. 约束、风险与未知项
- **忙状态并发竞态 (Processing Race Condition)**：如果后台任务刚好在 `onNotification` 触发时，用户正在输入新消息，或者大模型在前台正好处于执行另外一个工具的 `isProcessing = true` 忙碌期，此时忙目唤醒可能导致冲突。
  - **解决方案**：引入 `SessionContext.isProcessing` 忙锁保护。若处于忙状态，仅把事件消息加入历史消息堆栈，暂不触发外部 `chat()` 唤醒，待大模型本轮 `chat` 完成并退出忙碌时，在 `finally` 阶段检测是否有积压的通知，如果有，再级联触发新一轮 chat。
- **智能体无线死循环 (Infinite Loop Risk)**：如果后台命令频繁报错（例如 npm run dev 编译错误，Watcher 反复触发），大模型被唤醒后可能陷入“唤醒-修复失败-再次唤醒”的死循环。
  - **解决方案**：引入最大唤醒迭代次数限制，且 Watcher 包含断路器熔断保护。

## 5. 否决方案
- **方案 B (同步阻塞挂起等待)**：否决此方案，因为长达 30 分钟的依赖安装或测试执行会让智能体框架完全瘫痪，无法并发运行其他只读和交互动作。
- **无感知的后台静默写入**：否决仅将通知写入 `process.stdout` 而不注入上下文的做法，这使得自动看守器的价值仅对人类开发者可见，对智能体闭环推理无实质作用。
