## 背景

当前系统以 `HookEventName` 枚举定义插件可订阅的生命周期节点，包括 `SessionStart`、`SessionEnd`、`BeforeModel`、`AfterModel`、`BeforeTool`、`AfterTool`、`BeforeToolSelection`、`PreCompact`、`PostCompact` 九个事件。问题在于 `SessionStart` 和 `SessionEnd` 的命名与实际触发时机根本性错位：

- `SessionStart` 在 `AgentLoop.chat()` 方法入口触发，本质是单次 `chat/run` 的开始。
- `SessionEnd` 在 `AgentLoop.chat()` 的 `while` 循环体 `finally` 块中触发，即每次迭代结束均触发。这既不是"会话结束"，也不是真正的"run 结束"，只是"单轮迭代收尾"。
- `SessionEnd` 触发后立即调用 `SessionContext.clearTemporaryWhitelists()`，导致 `session` 级授权白名单（用户选择"会话始终放行"后写入）在每轮迭代后被清空，与 `ApprovalPolicy` 中"本次会话内所有相同操作自动放行"的语义直接冲突。
- 真正的 `SessionManager.close()` 不触发任何生命周期 Hook，系统缺乏"真实会话结束"的 Hook 边界。

## 目标与非目标

**目标:**
1. 将 `SessionStart` 重命名为 `RunStart`，并将对外暴露的 `RunEnd` 收敛为真正的单次 `chat/run` 结束事件。
2. 在 `SessionManager` 层引入真实的会话生命周期事件 `SessionOpened` / `SessionClosing` / `SessionClosed`。
3. 将临时授权白名单的清理由 `AgentLoop` 的迭代 `finally` 块迁移至 `SessionManager.close()` 的 `SessionClosed` 触发点，使 `session` 级授权覆盖真实会话生命周期。
4. 逐一复核所有订阅了 `SessionStart` / `SessionEnd` 的插件，将其 Hook 订阅点修正为符合真实意图的事件。

**非目标:**
1. 不引入面向用户的 `run` 级授权选项（如审批 UI 中新增"本次运行放行"按钮）。`run` 仅作为生命周期边界存在，本次不新增对应的白名单容器或授权来源。
2. 不拆分 `SessionContext` 的状态职责。虽已知 `SessionContext` 同时承载消息历史、审批服务、挂起交互、临时白名单桥接等多种职责，但该重构超出本次边界。
3. 不修改 `ApprovalPolicy.choiceId` 或 `CHOICE_RULES` 矩阵的用户可见选项集合。
4. 不改变 `call` capability 令牌（`registered → claimed → removed`）的生命周期机制。

## 架构决策

### 决策 1：Hook 事件硬重命名，不保留别名兼容

**选择**：硬删除 `SessionStart` / `SessionEnd` 枚举值，新增 `RunStart` / `RunEnd` / `SessionOpened` / `SessionClosing` / `SessionClosed`，所有消费方同步修改。

**替代方案**：保留旧枚举值为 `@deprecated` 别名，内部转发到新事件。否决原因：本项目无外部插件生态，所有订阅方均在仓库内可控修改；保留别名会增加枚举膨胀和调试混淆。

### 决策 2：SessionManager 通过显式 `open()` / `close()` 派发会话级 Hook

**选择**：在 `SessionManager` 中新增显式异步 `open()` 方法，并在组合根完成实例构造后主动调用。`open()` 和 `close()` 统一通过已有 `pluginRegistry` 字段获取订阅插件，调用 `runHookPipeline` 派发 `SessionOpened` / `SessionClosing` / `SessionClosed` 事件。

**数据流**：
```text
Composition Root
  → new SessionManager(...)
  → await session.open()
SessionManager.open()
  → runHookPipeline(SessionOpened, context, plugins, {})
SessionManager.close()
  → runHookPipeline(SessionClosing, context, plugins, {})   // 可拦截
  → abort() + rejectAll() + cancelPendingInteraction()      // 现有清理
  → taskAborter() + toolRegistry.close()                    // 现有清理
  → context.clearTemporaryWhitelists()                      // 从此处触发，不再在 AgentLoop 中
  → runSessionClosedPipeline(...)                           // 不可逆通知，禁止 fail-fast 中断后续插件
```

**替代方案**：在构造函数中直接调用 `runHookPipeline(SessionOpened, ...)`。否决原因：当前 `SessionManager` 构造函数是同步的，而 `runHookPipeline` 与插件 Hook 允许异步执行；若强行塞进构造函数，要么无法等待异步结果，要么迫使整个构造模型异步化且缺乏明确打开边界。

### 决策 2.1：SessionClosed 使用“忽略控制流”的专用派发语义

**选择**：`SessionClosed` 虽然仍复用同一套 Hook 基础设施，但其派发必须禁止 fail-fast 中断后续插件。实现上可以通过专用包装器（如 `runSessionClosedPipeline`）在每个插件返回后强制恢复 `control.action='continue'`，或在进入该阶段前构造一个“不可拦截”的上下文包装层。

**原因**：当前 `runHookPipeline` 的默认语义是任一插件返回 `abort` 或 `restart` 就短路后续插件。如果直接拿它派发 `SessionClosed`，那么某个插件一旦错误返回 `abort`，后续插件将永远收不到真正的会话关闭通知，这与 `SessionClosed` 的“不可逆、仅收尾”语义冲突。

### 决策 3：AgentLoop 将“迭代收尾”和“run 结束”彻底拆开

**选择**：
1. `AgentLoop.chat()` 入口处：`SessionStart` → `RunStart`
2. 当前位于 `while` 循环体 `finally` 中的 `flushPendingNotifications()` 与 `saveState()` 保留，继续作为每轮迭代的内部收尾机制
3. 从该 `finally` 中移除 `SessionEnd` Hook 派发和 `clearTemporaryWhitelists()` 调用
4. 在 `chat()` 真正返回、异常抛出或 abort 脱离前的统一外层收尾路径中，追加一次性的 `RunEnd` Hook 派发

这样 `RunEnd` 的语义才是真正的“本次 run 结束”，而不是“每轮迭代结束”。当前没有任何已知插件必须订阅“每轮迭代结束”这个公开事件，因此本次不再暴露该边界；若未来确有需要，应新增 `IterationEnd` 之类的专用事件，而不是继续污染 `RunEnd`。

### 决策 4：插件 Hook 订阅点按真实意图迁移

各插件的当前订阅与目标订阅对照：

| 插件 | 当前订阅 | 真实意图 | 目标订阅 |
|:---|:---|:---|:---|
| `LongTermMemoryPlugin` | `SessionEnd` | "在会话结束时异步提炼有价值的知识和事实"（类注释原文） | `SessionClosed` |
| `TracerLogPlugin` | `SessionEnd` | 对本次 run 的收尾与上下文 patches 做最终审计记录 | `RunEnd` |
| `JitRulesPlugin` | `SessionStart` | 在单次 run 开始时初始化 JIT 伴生规则捕获 | `RunStart` |
| `LoopPreventionPlugin`(core) | `SessionStart` | 在单次 run 开始时初始化工具调用指纹追踪 | `RunStart` |
| `LoopPreventionPlugin`(adapters) | `SessionStart` | 同上 | `RunStart` |

**关键判断依据**：`LongTermMemoryPlugin` 的 `handleSessionEndAsync` 方法签名及类级注释均明确表达了"会话结束"的语义，而非"单轮推理结束"。当前将其挂在 `SessionEnd` 是受命名误导——因为大循环每次迭代都会触发它，导致频繁但无意义的提炼检查；迁移到 `SessionClosed` 后，仅在会话真正关闭时触发一次提炼，更符合设计意图。

### 决策 5：SecurityService 白名单清理仅绑定 SessionClosed

**选择**：`clearTemporaryWhitelists(sessionId)` 仅在 `SessionManager.close()` 的 `SessionClosed` 阶段调用，不再在任何 `RunEnd` 点调用。

**影响**：`session` 授权（用户选择"会话始终放行"）写入的读/写/目录范围白名单，现在在整个 `SessionManager` 生命周期内有效，跨多次 `chat/run` 调用持续生效，直至会话关闭。

**安全保障**：`call` capability 令牌不受影响，其 `registered → claimed → removed` 生命周期已通过独立的 `registerCallCapability` / `claimCapability` / `consumeCapability` 机制实现，边界清晰。

## 风险与权衡

- **[Hook 订阅遗漏风险]**：若存在未在 `src/` 目录下搜索到的 `SessionStart` / `SessionEnd` 引用（如配置文件中的字符串引用），编译期会因枚举值删除而暴露。缓解：TypeScript 编译检查会在 CI 阶段拦截所有引用旧枚举名的代码。
- **[LongTermMemoryPlugin 行为变更]**：当前该插件在每次迭代结束时都检查是否需要提炼（受 `ragRefinementThreshold` 阈值保护），迁移到 `SessionClosed` 后仅在会话关闭时触发一次。若用户在超长会话中期望中间周期性提炼，则需要未来额外引入定时或轮次触发机制。缓解：当前阈值保护已使大部分迭代跳过提炼；真正的提炼原本就应在会话结束时执行；超长会话的中间提炼可作为后续需求单独建模。
- **[自动唤醒链路的语义归属]**：自动唤醒（auto-wakeup）会重复调用 `runInternalGeneration()` → `chat()`。在当前设计中，每次 auto-wakeup 是一个新的 `RunStart` / `RunEnd` 循环，但 `session` 白名单跨 run 持续有效。这避免了旧行为中每次 auto-wakeup 后白名单被清空的问题，但也意味着用户在 auto-wakeup 链路中授予的 `session` 授权会持续生效——这符合"会话始终放行"的承诺。
- **[SessionClosing 可拦截性的边界]**：`SessionClosing` Hook 允许插件返回 `abort` 阻止会话关闭。若插件滥用此能力（如永不返回 `continue`），会话将无法关闭。缓解：本次先保持显式 abort 语义，不额外引入超时强杀逻辑；若未来出现真实阻塞问题，再单独为“关闭超时策略”建模，避免把两个目标绑定在一个 change 中。

## 开放问题

- `LongTermMemoryPlugin` 迁移到 `SessionClosed` 后，超长会话（数小时、数百轮对话）的内存提炼将延迟到会话关闭时。是否需要在中间引入"周期性提炼"触发点（如每 N 轮或每 M token）？建议作为独立需求单独建模。
