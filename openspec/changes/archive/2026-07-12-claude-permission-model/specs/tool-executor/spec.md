## REMOVED Requirements

### Requirement: Executor Internal Approval Fallback

**Reason:** ToolExecutor 内部审批会形成第二套权限模型，并可能绕过 Claude 风格统一决策流程。

**Migration:** ToolExecutor 只执行已经通过 ToolCallGateway 的调用；直接执行必须被封装或使用不可伪造的内部调用上下文阻断。

## ADDED Requirements

### Requirement: Gateway-Only Tool Execution

ToolExecutor MUST 只接受统一权限入口生成的合法执行上下文，不得自行读取模式、调用人工审批或产生新的权限决策。

#### Scenario: Unauthorized direct execution is rejected

- **WHEN** 调用方没有统一入口生成的内部执行上下文而直接调用 ToolExecutor
- **THEN** ToolExecutor MUST 拒绝执行

#### Scenario: Authorized execution runs once

- **WHEN** ToolCallGateway 已完成权限决策并生成合法执行上下文
- **THEN** ToolExecutor MUST 执行目标工具一次，且不得再次触发人工审批
