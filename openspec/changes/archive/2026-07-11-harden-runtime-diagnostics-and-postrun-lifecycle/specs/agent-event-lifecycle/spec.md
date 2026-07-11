## ADDED Requirements

### Requirement: 质量门禁状态必须位于 complete 之前且不得终结渲染

系统必须（MUST）通过专用 `quality_check_status` AgentEvent 表达质量门禁状态。该事件是非终结事件，不得恢复输入监听；`complete` 仍是本轮唯一终结点。

#### Scenario: 质量门禁开始与通过

- **WHEN** 真实代码变更触发质量门禁并最终通过
- **THEN** 系统必须在 complete 前依次发出 started 与 passed 状态，CLI/TUI 保持渲染中，并只在随后收到 complete 时恢复输入

#### Scenario: 质量门禁失败

- **WHEN** 质量门禁最终失败且不再自动修复
- **THEN** 系统必须发出 failed 状态和受限摘要，随后仍发出唯一 complete；failed 本身不得修改 InputListener 生命周期

#### Scenario: 质量门禁取消

- **WHEN** 会话关闭或生成取消导致质量门禁中止
- **THEN** 系统可以发出 cancelled 状态，但不得产生重复 complete 或让 CLI 永久停留在渲染状态

