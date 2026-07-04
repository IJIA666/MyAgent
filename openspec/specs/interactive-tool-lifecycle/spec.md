# interactive-tool-lifecycle

## Purpose

为需要进行人类交互等待的工具（如 `ask_user_question`、审批卡关）提供统一的人机中断式执行生命周期管理。通过 `NativeTool` 接口层的 `executionMode` 字段区分普通即时工具（`immediate`）与人机中断工具（`human_interruption`），使 agent-loop 能够按工具类型差异化决定执行模型与超时策略，避免人机等待时间被错误计入通用工具执行超时预算。

## Requirements

### Requirement: 人机中断执行模型

需要人类主动交互才能完成的工具 MUST 在 `NativeTool` 元数据层通过 `executionMode` 字段声明自身的人机中断属性，使 agent-loop 可以区分"普通即时执行"和"人机交互中断"。

#### Scenario: 声明为人机中断

- **WHEN** 一个工具的实现类设置 `executionMode: 'human_interruption'`
- **THEN** agent-loop 在执行此工具时：创建待回答的 `pendingInteraction` 记录，跳过通用 `AbortController` 超时熔断的 `signal.aborted` 检查，等待用户主动回答或外部取消

#### Scenario: 默认值为即时执行

- **WHEN** 工具实现类未显式设置 `executionMode`
- **THEN** 该工具被视为普通即时工具（`immediate`），遵循现有 `toolTimeoutMs` 超时策略。缺省行为确保向后兼容

### Requirement: 人机中断无默认超时

人机中断工具 SHOULD NOT 依赖框架层自动超时。等待的结束条件应当由调用方显式决定（回答、取消、会话关闭），而非框架注入默认超时。

#### Scenario: 不设自动超时

- **WHEN** agent-loop 执行一个 `executionMode: 'human_interruption'` 的工具
- **THEN** 该工具的等待默认不受 `toolTimeoutMs` 约束。框架不为该等待注入自动超时。仅在用户回答、用户取消、会话关闭或进程退出时结束

#### Scenario: 外部取消仍通过 AbortSignal 传达

- **WHEN** 用户通过 Ctrl+C 或上层代码通过 `AbortController.abort()` 取消
- **THEN** AbortSignal 的 `abort` 事件仍会传达到交互层，工具应正常返回空字符串。仅自动超时不触发，外部取消链路保持畅通

### Requirement: agent-loop 执行策略分发

agent-loop 在执行工具调用时 MUST 根据 `NativeTool.executionMode` 字段决定使用哪种执行模型与超时策略。

#### Scenario: 即时工具走统一超时

- **WHEN** agent-loop 准备执行一批工具调用且工具为 `immediate`
- **THEN** MUST 使用现有 `toolTimeoutMs`（默认 30 秒）设置 `AbortController` 超时

#### Scenario: 人机中断工具无超时，跳过信号检查

- **WHEN** agent-loop 执行 `human_interruption` 工具
- **THEN** MUST 跳过 `executeToolTask` 中的 `signal.aborted` 熔断检查，允许工具在其自身生命周期内完成等待

#### Scenario: 工具实例不存在兜底

- **WHEN** `toolRegistry.getTool()` 返回 `undefined`
- **THEN** 执行模型 MUST 回退为 `immediate`，确保未注册工具按即时安全处理
