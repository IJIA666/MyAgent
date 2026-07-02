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
