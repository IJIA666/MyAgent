## Purpose

定义 SessionManager 打开、关闭和终结通知的生命周期顺序。该规范确保插件只在资源状态一致的边界收到事件，并让会话权限状态、挂起交互和物理连接由各自所有者完成收尾。

## Requirements

### Requirement: 会话管理器必须在显式打开会话时派发 SessionOpened 生命周期事件

会话管理器（SessionManager）在完成自身及所有依赖的构造后，必须（MUST）通过显式 `open()` 生命周期入口，调用标准 Hook 管道（runHookPipeline）派发 `SessionOpened` 事件，允许插件在会话开始前执行初始化逻辑。

#### Scenario: 正常会话打开触发插件初始化
- **WHEN** SessionManager 构造完成，外部显式调用 `open()`，且所有依赖（LlmPort、ToolRegistryPort、PluginRegistry、ContextRepository 等）已就绪
- **THEN** SessionManager 必须在 `open()` 中调用 `runHookPipeline(HookEventName.SessionOpened, context, plugins, {})` 派发事件
- **AND** 插件注册中心中所有订阅了 `SessionOpened` 的插件按权重排序后依次执行

#### Scenario: SessionOpened 阶段插件 abort 阻止会话启动
- **WHEN** 任一订阅了 `SessionOpened` 的插件返回 `{ control: { action: 'abort', reason: '...' } }`
- **THEN** Hook 管道必须立即短路，`open()` 必须抛出异常或阻止会话进入可用状态
- **AND** 已执行的插件清理逻辑不受回滚

### Requirement: 会话管理器必须在会话关闭前派发 SessionClosing 可拦截事件

会话管理器在关闭会话时 MUST 在执行资源清理之前，通过标准 Hook 管道派发 `SessionClosing` 事件，允许插件执行拦截或阻止关闭。

#### Scenario: 正常关闭前通知插件
- **WHEN** 外部调用 `SessionManager.close()`
- **THEN** SessionManager 必须首先调用 `runHookPipeline(HookEventName.SessionClosing, context, plugins, {})`
- **AND** 只有在所有订阅插件返回 `continue` 后，才进入实际的资源清理阶段

#### Scenario: 插件 abort 阻止会话关闭
- **WHEN** 任一订阅了 `SessionClosing` 的插件返回 `{ control: { action: 'abort', reason: '...' } }`
- **THEN** Hook 管道必须短路，`close()` 必须抛出异常或返回拒绝状态，不得继续执行资源清理

### Requirement: 会话管理器必须在会话关闭后派发 SessionClosed 不可逆通知事件

会话管理器在所有资源清理完成后，必须（MUST）通过标准 Hook 管道派发 `SessionClosed` 事件，作为会话生命周期的终结点。此事件不可拦截，仅供仍然注册的插件执行通用收尾清理。

#### Scenario: 正常关闭后通知插件收尾
- **WHEN** SessionManager 已完成 `abort()`、`rejectAll()`、`cancelPendingInteraction()`、`taskAborter()` 和 `toolRegistry.close()`，且当前 SessionContext 不再接受新的 run
- **THEN** SessionManager 必须调用 `runHookPipeline(HookEventName.SessionClosed, context, plugins, {})`
- **AND** 插件在此阶段返回的任何 `control.action`（除 `continue` 外）均被忽略，会话关闭不可逆转

#### Scenario: SessionClosed 仅触发一次
- **WHEN** `SessionManager.close()` 被多次调用（重复关闭防护）
- **THEN** `SessionClosed` 事件仅在实际执行清理的首次调用中触发，后续调用为幂等空操作
