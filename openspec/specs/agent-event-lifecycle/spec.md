## 修改需求

### Requirement: Agent 事件生命周期 SHALL 以 complete 为唯一的状态终结点

会话管理器在推理生成过程中，无论正常结束还是发生异常，MUST 保证 `complete` 事件是每一轮推理生命周期的最后一个状态事件。CLI 层 SHALL 仅以 `complete` 事件作为恢复用户输入监听和结束渲染周期的唯一触发条件。

#### Scenario: 正常推理完成
- **WHEN** agent 推理正常结束，无工具调用残留
- **THEN** 会话管理器 emit `complete` 事件，CLI 层将 `isRendering` 置为 `false` 并恢复 InputListener

#### Scenario: 推理过程中发生灾难性异常
- **WHEN** agent 推理过程中发生不可恢复的异常（如 API 网络断开、LLM 请求崩溃），catch 块捕获异常
- **THEN** 会话管理器 SHALL 先 emit `error` 事件传递异常信息，随后 SHALL emit `complete` 事件作为本轮生命周期的终结。CLI 层在收到 `complete` 后恢复输入监听。灾难性异常后 SHALL NOT 触发 auto-wakeup

#### Scenario: 流内 error 事件（非灾难性）
- **WHEN** agent 推理过程中发生非灾难性的 error（如工具被插件 abort，后续仍有 `tool_call_result` 和更多推理事件）
- **THEN** CLI 层 SHALL NOT 修改 `isRendering` 或 InputListener 状态。error 事件仅作为信息展示，不影响渲染状态机

#### Scenario: 双重 complete 防护
- **WHEN** catch 块已补发 `complete`（`hasError = true`）
- **THEN** finally 块 SHALL NOT 再次 emit `complete`（通过 `!hasError` 条件阻止）

### Requirement: error 事件 SHALL NOT 影响 CLI 渲染状态机

CLI 层处理 `error` 事件时，MUST NOT 将 `isRendering` 置为 `false`，MUST NOT 恢复或重启 InputListener。error 事件仅做终端文本输出。

#### Scenario: error 事件的 CLI 处理
- **WHEN** CLI 层收到类型为 `error` 的 agent 事件
- **THEN** 仅调用 `console.log` 输出异常信息，不修改 `this.isRendering`、不调用 `this.listener.resume()`、不调用 `this.listener.pause()`

### Requirement: 所有斜杠命令 SHALL 以 stdin 独占事务执行

所有斜杠命令（`/` 开头）的分发执行链路 MUST 视为一个不可分割的 stdin 独占事务。在此期间 SHALL NOT 允许全局 InputListener 与 Clack 并发消费 process.stdin。

`CommandContext.rl` 字段 SHALL 被移除，因为分发前监听器已关闭，`getInterface()` 返回 null，不存在有效的 readline 实例可传入。

#### Scenario: 菜单导航期间防止 stdin 所有权竞争
- **GIVEN** 用户输入 `/` 触发交互式菜单，或直接输入斜杠命令（如 `/workmode`、`/model`）
- **WHEN** CLI 层进入斜杠命令分发流程
- **THEN** SHALL 立即关闭或彻底解绑全局 InputListener
- **AND** SHALL NOT 在命令分发的任何 `finally` 块中恢复监听器
- **AND** SHALL 在所有嵌套交互（`showInteractiveMenu` + `dispatchCommand` + 内部二级 Clack）全部结束后，**只恢复一次**全局 InputListener
- **AND** 不得在此过程中触发 `handleLineSubmit` → `handleUserInput` 链

#### Scenario: 直接输入带 Clack 交互的斜杠命令
- **GIVEN** 用户直接输入 `/workmode` 或 `/model` 等自带二级 Clack 菜单的命令
- **WHEN** CLI 层先关闭全局监听器再分发命令
- **THEN** SHALL 仍确保 Clack 独占 stdin
- **AND** Clack 退出后统一恢复监听器

#### Scenario: 命令分发后启动 LLM 推理
- **WHEN** `dispatchCommand` 返回了需要与 LLM 交互的结果（`shouldResume = false`）
- **THEN** 执行顺序 SHALL 固定为：
  1. `dispatchCommand` 返回
  2. `listener.start(true)` 以 paused 状态重建监听器（在 `finally` 块中执行）
  3. `session.handleUserInput(input, transientSkillContent)`（在 `finally` 之后执行）
  4. `complete` 事件调用 `listener.resume()`
- **AND** SHALL NOT 先调用 handleUserInput 再在 finally 中重建

#### Scenario: showInteractiveMenu / dispatchCommand 异常后监听器恢复
- **GIVEN** `close()` 已关闭全局监听器
- **WHEN** `showInteractiveMenu()` 或 `dispatchCommand()` 抛出异常
- **THEN** 监听器 SHALL 仍被恢复（通过 `try/finally` 保证）
- **AND** 不得因未捕获的异常导致 CLI 永久失去 stdin 输入能力

#### Scenario: handleUserInput 同步抛错后监听器不卡死
- **GIVEN** 监听器已以 paused 状态重建（`start(true)`）
- **WHEN** `session.handleUserInput()` 因 `isGenerating` 忙而同步抛出 `Error`
- **THEN** catch 块 SHALL 立即调用 `listener.resume()` 将监听器恢复为 active 状态
- **AND** CLI 不得因该同步异常永久卡死在 paused 状态

### Requirement: InputListener 的 pending resume 与延迟 line 事件 SHALL 可取消

`resume()` 的 `setImmediate` 延迟回调 SHALL 具备版本号可取消机制。`close()` 后旧 readline 实例发出的延迟 `line` 事件 SHALL 被新实例丢弃。

#### Scenario: pause 后过期 resume 回调被抑制
- **GIVEN** `resume()` 通过 `setImmediate` 调度了一个延迟恢复回调
- **WHEN** 在该回调执行前，又发生了 `pause()` 或 `close()` 调用
- **THEN** 该延迟回调 MUST NOT 将 `isPaused` 置为 `false`
- **AND** SHALL 通过单调递增版本号机制实现：每次 `pause()`/`close()` 递增版本号，延迟回调捕获创建时的版本号，执行时与当前版本号比较，不匹配则跳过

#### Scenario: 旧 readline 延迟 line 事件在新 start() 后穿透
- **GIVEN** `close()` 后旧 readline 仍在事件循环队列中残留已排队的 `line` 事件
- **WHEN** 新 `start()` 创建了新的 readline 实例
- **THEN** 旧 readline 的延迟 `line` 回调 SHALL 被丢弃
- **AND** SHALL 通过 `rlInstanceId` 实现：`start()` 创建新 rl 前递增 ID；`close()` 递增 ID；`line` 回调闭包捕获创建时 ID，执行时与当前 ID 比较，不匹配则丢弃
- **AND** `close()` SHALL 显式调用 `this.rl?.removeAllListeners('line')` 作为防御性补充
- **AND** `close()` SHALL 立即设置 `this.isPaused = true`
