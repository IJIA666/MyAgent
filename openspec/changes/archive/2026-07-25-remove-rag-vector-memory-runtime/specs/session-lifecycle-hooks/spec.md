## MODIFIED Requirements

### Requirement: 会话管理器必须在会话关闭后派发 SessionClosed 不可逆通知事件

会话管理器在所有资源清理完成后，必须（MUST）通过标准 Hook 管道派发 `SessionClosed` 事件，作为会话生命周期的终结点。此事件不可拦截，仅供仍然注册的插件执行通用收尾清理。

#### Scenario: 正常关闭后通知插件收尾

- **WHEN** SessionManager 已完成 `abort()`、`rejectAll()`、`cancelPendingInteraction()`、`taskAborter()`、`toolRegistry.close()` 和 `clearTemporaryWhitelists()` 全部清理步骤
- **THEN** SessionManager 必须调用 `runHookPipeline(HookEventName.SessionClosed, context, plugins, {})`
- **AND** 插件在此阶段返回的任何 `control.action`（除 `continue` 外）均被忽略，会话关闭不可逆转

#### Scenario: SessionClosed 仅触发一次

- **WHEN** `SessionManager.close()` 被多次调用（重复关闭防护）
- **THEN** `SessionClosed` 事件仅在实际执行清理的首次调用中触发，后续调用为幂等空操作
