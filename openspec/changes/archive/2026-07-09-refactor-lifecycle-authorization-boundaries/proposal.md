## 改造原因

当前系统中"会话生命周期"与"单次推理运行"的边界严重错位：

- `SessionStart` / `SessionEnd` Hook 名义上承担运行/会话生命周期语义，但实际触发边界并不准确。尤其 `SessionEnd` 在 `while` 循环体的 `finally` 中触发，导致它实质上是每次迭代结束事件，而非会话关闭事件。
- 会话级临时白名单（承载 `session` 授权语义）在 `SessionEnd` 触发时立即通过 `clearTemporaryWhitelists()` 清空。这意味着用户选择的"会话始终放行"实际只能存活到当前迭代结束，与 `ApprovalPolicy` 中"本次会话内所有相同操作自动放行"的表述直接冲突。
- `SessionManager.close()` 不会触发任何 `SessionEnd` Hook，系统甚至不存在"真实 session 结束"的 Hook 边界。`LongTermMemoryPlugin`、`TracerLogPlugin` 等插件已将 `SessionEnd` 误解为真实会话结束点，语义失真已传导至插件行为。
- 授权作用域（call / run / session / persistent）没有显式建模，导致 `session` 级授权的行为与实现机制（临时白名单生命周期）不在同一抽象层，后续扩展和调试成本高。

## 变更内容

### 第一阶段：事件语义拉直

- **BREAKING**: 将当前 `SessionStart` Hook 重命名为 `RunStart`，并将当前 `SessionEnd` 的职责拆开：`RunEnd` 仅在 `AgentLoop.chat()` 真正结束时触发一次；原先位于每轮迭代 `finally` 中的内部落盘与通知刷新逻辑继续保留为引擎内部机制，但不再对外暴露为会话/运行生命周期 Hook。
- **BREAKING**: 调整所有订阅了 `SessionStart` / `SessionEnd` 的插件（LongTermMemoryPlugin、TracerLogPlugin、LoopPreventionPlugin 等），逐一复核其真实意图，修改 Hook 订阅点。
- 将 `iteration` 明确作为 `AgentLoop.chat()` 内部的控制流循环变量，不再通过 Hook 系统对外冒充会话生命周期。

### 第二阶段：真实生命周期与授权作用域重整

- 在 `SessionManager` 层引入真实会话生命周期事件：`SessionOpened`（显式打开会话时）、`SessionClosing`（会话即将关闭，可拦截）、`SessionClosed`（会话已关闭，不可逆）。
- 将临时白名单清理由当前 `AgentLoop` 的 `finally` 块移至 `SessionManager.close()` 中的 `SessionClosed` 触发点，使 `session` 级授权真正覆盖整个会话生命周期。
- 将生命周期层次与授权层次显式区分：
  - `call`：当前工具调用级别的授权机制，执行后即失效。
  - `run`：当前一次 `chat/run` 的执行边界，仅用于生命周期建模，不新增用户可见授权选项。
  - `session`：当前 `SessionManager` 实例生命周期有效，会话关闭时清理。
  - `persistent`：落盘持久化，跨会话有效。
- 本次不引入新的 `run` 级白名单容器，避免在缺乏真实授权来源的情况下过度设计。

## 业务能力

### 新增业务能力
- `session-lifecycle-hooks`: 真实会话生命周期 Hook 事件体系（SessionOpened / SessionClosing / SessionClosed），填补当前系统缺失的会话级边界。
- `authorization-scope-boundaries`: 显式区分生命周期边界与授权边界，确保 `session` 授权仅绑定真实会话关闭点，`call` 与 `persistent` 机制保持独立。

### 修改业务能力
- `agent-loop-lifecycle-plugin`: **BREAKING** — 现有 `SessionStart` 重命名为 `RunStart`；原 `SessionEnd` 不再保留原有语义，其对外生命周期职责重整为真正的 `RunEnd`，所有订阅插件需更新订阅点。
- `approval-capability-lifecycle`: 会话级授权令牌的生命周期从"单次 run 结束时清除"调整为"真实 session 关闭时清除"，使其与 `session` 语义对齐。

## 影响范围

- **Hook 事件系统**：`HookEventName` 枚举、Hook 派发管道、所有插件的 Hook 注册点。
- **AgentLoop 核心引擎**：`chat()` 方法中的 Hook 触发点、`finally` 块中的白名单清理逻辑。
- **SessionManager**：新增显式 `open()` / `close()` 生命周期 Hook 触发，白名单清理职责迁移。
- **ApprovalPolicy**：`session` choice 的文案表述保持对齐，`mapChoiceToEffect` 中 `session` 分支不变但语义更正。
- **插件层**：`LongTermMemoryPlugin`、`TracerLogPlugin`、`LoopPreventionPlugin`等需复核并修正 Hook 订阅意图。
- **SessionContext**：临时白名单容器无需新增 `run` 分层，但需要调整清理触发时机。
- **HumanApprovalPlugin**：`session` 型 `PendingGrant` 提交路径中的白名单写入逻辑不变，但其生效生命周期变长。
