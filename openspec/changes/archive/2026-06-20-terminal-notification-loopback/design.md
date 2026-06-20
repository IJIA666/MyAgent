## 背景
在之前的开发中，我们为异步终端重构了状态机、Ansi-Strip卡死看守（Stall Watchdog）与日志行匹配（Watcher），并通过 `onNotification` 发送通知。然而，这些通知无法被已经同步返回并处于闲置状态的大模型看到，限制了其自主处理卡死与接收进程成果的自动化闭环。

本设计文档旨在在 `SessionContext`、`SessionManager` 及 `ExecuteCommandTool` 的调用链上建立无缝的异步消息分发总线，让事件能动态以合规形式写入对话历史，并在空闲期自动唤醒大模型。

## 架构设计

### 1. 基于 EventEmitter 的 SessionContext 事件分发器
* **设计目标**：由于 `SessionContext` 原本只是一个纯数据结构体类，为了支持事件监听，我们将为其扩展或封装事件发射（`EventEmitter`）能力，从而连通 Pub/Sub 订阅体系。
* **实现方案**：
  * 在 `src/brain/context.ts` 中，使 `SessionContext` 继承 `EventEmitter`（来自 Node.js 原生 `'events'` 模块）。
  * 暴露出事件名称 `async_event`。每当后台任务状态更改、卡死或行匹配命中时，将触发 `this.emit('async_event', event)`。

### 2. 兼容 LLM API 的 role: 'user' 消息注入
* **设计目标**：防范将中途通知错误地作为 `role: 'system'` 发送给模型而导致的大部分主流大语言模型 API 拒绝响应或格式混乱问题。
* **实现方案**：
  * 修改 `terminal.ts` 的 `ExecuteCommandTool.execute`。在传入 `onNotification` 的回调动作中，除了向 stdout 打印外，还要利用 `sessionContext` 提供的方法，直接在会话的消息历史中追加一条 `role: 'user'` 消息。
  * 为了防止这条由系统产生的文件通知消息被模型误认为是由人类用户手动输入的命令，其格式必须以专用的 XML 标签进行严格的语义包裹，并在头部指明这是由沙箱任务产生的系统事件通知：
    ```xml
    <system_notification>
      <event_type>watch_match | completed | stalled</event_type>
      <task_id>task_xxxxxxxx</task_id>
      <summary>Background command "..." completed (exit code 0)</summary>
      <log_slice>Last output content ...</log_slice>
    </system_notification>
    ```

### 3. 双层忙锁与外部隐式自动唤醒
* **设计目标**：
  * **Plugin 忙锁（SessionContext.isProcessing）**：仅代表 Hook 中间件管道正在执行，限制此期间不能直接写入 `messageHistory` 以防脏写。此时触发的 `onNotification` 需暂存进 `pendingNotifications` 队列，在 `isProcessing` 变回 `false` 时自动 flush 追加。
  * **推理忙锁（CliFacade.isGenerating）**：代表大模型正处于 ReAct 推理生成大循环中。当大模型闲置（`isGenerating === false`）且收到后台通知时，才能安全触发自动唤醒。
* **实现方案**：
  * 在 `SessionContext` 中，通过 `addNotification` 暂存机制规避 `isProcessing = true` 期间调用 `addMessage` 造成的抛错。
  * 外部驱动层 `CliFacade` 订阅 `async_event` 事件。当事件被触发时，执行以下检查：
    ```typescript
    if (!this.isGenerating) {
      // 只有在大模型空闲时才立即隐式触发唤醒！
      // 启动外部 REPL 重新调起 runStreamLoop()
    } else {
      // 若大模型正在推理，仅记录积压标记，在本轮 chat 结束后再级联触发
      this.hasPendingAsyncNotification = true;
    }
    ```


## 风险与权衡
* **死循环风险 (Infinite Loop)**：如果后台编译脚本反复出错，Watcher 频繁命中，智能体被自动唤醒后又开始构建，可能形成“报错 -> 自动唤醒 -> 再次报错 -> 再次唤醒”的无休止 Token 消耗。
  * **权衡与预防**：必须在 `SessionManager` 或 REPL 驱动层限制“无人值守”情况下的自动唤醒最大连续迭代次数（例如连续自动唤醒上限设为 3 次，超限后强制降级为等待人类输入）。
* **多任务并发消息插队 (Interleaving Messages)**：如果后台有多个并行的任务同时触发通知，多条 user 通知消息可能会交织灌入。
  * **权衡与预防**：通过 `CliFacade` 维护的 `hasPendingAsyncNotification` 标记防范竞态。在一轮推理（`isGenerating === true`）期间到达的所有通知在写入 Context 历史的同时不会立即拉起新 chat。直到本轮推理流完成释放时，在 `runStreamLoop` 的 `finally` 阶段，通过异步宏任务检测该标记。若有积压，则立即拉起新一轮 `runStreamLoop`，保证时序合理。
