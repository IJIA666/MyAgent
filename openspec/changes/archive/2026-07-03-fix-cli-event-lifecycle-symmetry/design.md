## 背景

当前事件生命周期由两层共同维护：

1. **`session.ts` `runInternalGeneration()`**：负责事件的生成与生命周期收尾。try 块中通过 `agentLoop.chat()` 逐事件 emit。catch 块中仅 emit `error`，不 emit `complete`。finally 块中 `if (!hasError && !willWakeup)` 仅在无错误时 emit `complete`。设计意图写在第 403-404 行注释中——error 事件自己负责触发 ClI 状态恢复。

2. **`facade.ts` `handleAgentEvent()`**：负责事件的 ClI 渲染。error case 中设置 `isRendering = false` 并 `listener.resume()`，将 error 视为渲染终止点。

这一非对称设计在流内 error（工具被 abort）场景下失效——error 之后还有 `tool_call_result` 和后续 ReAct 轮次，过早恢复渲染状态会导致状态混乱和显示错乱。

## 目标与非目标

**目标:**
- 将 `complete` 确立为唯一的 CLI 渲染状态终结点
- error 退化为纯信息打印事件，不参与 `isRendering` 或 `listener` 状态管理
- 确保灾难性崩溃（API 断连）和流内 error（工具 abort）两种场景下 CLI 状态都能正确恢复

**非目标:**
- 不修改 agent-loop 的事件生成逻辑
- 不引入新的 `AgentEvent` 事件类型

## 架构决策

### 决策 1：对称式契约——complete 统一收尾

**选择**：catch 块在 emit `error` 后补发 `complete`。finally 块中移除对 `!hasError` 的部分依赖（nextTick 加守卫，line 406 保持不变）。

**理由**：当前 `if (!hasError && !willWakeup)` 中 `!hasError` 阻止 error 路径 emit complete，这是问题的根源。在 catch 块直接补发 `complete` 后，line 406 的 `!hasError` 自动防止双重 emit——修改最小。

**替代方案**：
- 移除 line 406 的 `!hasError` 条件，让 finally 统一 emit complete：需要额外处理 `willWakeup` 的优先级，改动更大
- 引入新的 `fatal` 事件类型：过度设计，对称契约下不需要

### 决策 2：nextTick 增加 `!hasError` 守卫

**选择**：`process.nextTick(() => { if (!hasError && !this.isGenerating && this.hasPendingAsyncNotification) { ... } })`。

**理由**：catch 块已补发 `complete`，若 `hasPendingAsyncNotification` 为 true 且 nextTick 无守卫，会在 `complete` 之后误触发 auto-wakeup，导致新的推理轮次在用户交互期间启动。

### 决策 3：facade.ts error case 纯化

**选择**：error case 仅保留 `console.log`，删除 `isRendering = false` 和 `listener.resume()`。

**理由**：`complete` 已是唯一状态终结点。error 事件在各种场景下都只是流中间的旁注（工具 abort → 流继续；API 崩溃 → catch 补发 complete），不应干预状态。

## 风险与权衡

| 风险 | 缓解策略 |
|:---|:---|
| catch 块补发 `complete` 后，finally 的 line 406 也满足条件导致双重 emit | line 406 的 `!hasError` 自动阻止——catch 块中 `hasError = true`，finally 块不 emit。已验证不会双重 emit |
| 修改后 error 事件在其他未知场景下行为变化 | error 仅从"状态终结者"变为"纯打印"，语义上仅收窄不扩大，风险可控 |

### 决策 4：`handleLineSubmit` stdin 独占事务重构 [Amend 修正 — 替换原 setImmediate 方案]

**先前的错误方案**（已废弃）：此前将根因误判为 `dispatchCommand` 路径中 `resume()` 后 readline 缓冲区残留事件，尝试用 `setImmediate` 延迟恢复 + `isGenerating` 入口守卫来解决。经日志追踪和源码分析确认此方向错误。

**根因重新分析**：Bug 3（WorkMode 切换被锁 + 异常自动回复）的竞态链路如下：

| 时刻 | 操作 | isPaused |
|:---|:---|:---|
| T1 | 用户输入 `/` → `handleLineSubmit` → 进入菜单 | `true` |
| T2 | 菜单 `finally` 块调用 `listener.resume()`（line 214） | 立即恢复 readline，但 isPaused=false 延迟到 setImmediate |
| T3 | 输入变为 `/workmode` → 命令分发 `dispatchCommand` → 再次 `listener.pause()` | `true` |
| T4 | 步骤 T2 遗留的过期 setImmediate 回调执行 → isPaused=false | **`false`** ← 反向覆盖 |
| T5 | 两级 Clack 菜单同时消费 process.stdin → 旧 readline 发出重复 line | 竞态 |
| T6 | 重复的原始消息被提交 → `handleUserInput` → 异常推理启动 | - |
| T7 | WorkMode 切换修改执行 → 撞上 SessionStart hook 的 isProcessing 锁 | - |

**`isProcessing` 被锁是果，不是因。根因是 CLI 的 stdin 所有权竞争导致原用户输入被重复提交。**

Node.js readline 文档明确指出 `rl.pause()` 不能立即阻止 `line` 事件继续发出，因此依赖 pause/setImmediate 的隔离方案本质不可靠。

**选择**：将"所有斜杠命令分发"视为一个 **stdin 独占事务**——不仅是 `/` 菜单入口，直接输入 `/workmode`、`/model` 等也会启动 Clack。具体约束：

1. **斜杠命令分发前**（`input.startsWith('/')` 分支入口）调用 `this.listener.close()`，彻底解除 readline 对 process.stdin 的监听，使后续 Clack 独占 stdin
2. **移除所有 `finally` 块中的 `listener.resume()`**，不在中途任何位置恢复监听
3. **异常安全恢复（阻断性要求）**：`close()` 之后的所有交互操作（`showInteractiveMenu`、`dispatchCommand`、Clack 菜单）必须包裹在 `try/finally` 中，`finally` 保证**恰好一次** `listener.start(paused)` 恢复监听器，无论 try 块中是正常返回还是抛出异常：
   ```
   listener.close()
   let pendingLLM: CommandResult | null = null
   try {
     // 菜单 + 命令分发 + 记录 LLM 请求
   } finally {
     // 保证：无论异常与否，一定恢复监听器
     if (pendingLLM) listener.start(true)   // paused，由 complete 恢复
     else listener.start(false)             // 立即 active
   }
   // LLM 请求在 finally 恢复监听器之后执行
   if (pendingLLM) {
     try {
       session.handleUserInput(pendingLLM.userMessage, pendingLLM.transientSkillContent)
     } catch {
       // handleUserInput 同步抛错（如 isGenerating 忙），监听器不能卡在 paused
       listener.resume()
     }
   }
   ```
4. **`CommandContext` 移除未使用的 `rl` 字段**，因为分发前监听器已关闭，`getInterface()` 返回 null，`!` 仅欺骗 TypeScript 不提供运行时保障

**理由**：解决"两个 readline 消费者"的根本方法是确保同一时间**只有一个**消费者持有 stdin。关闭全局监听器 = 彻底解除绑定；Clack 独占 stdin；Clack 退出后再重建监听器。pause/resume 的语义在 stdin 竞争场景下不可靠。

**影响**：
- `facade.ts`：重写 `handleLineSubmit` 控制流（line 180-243），关闭监听器范围从 `/` 菜单扩大到所有斜杠命令分发
- `src/adapters/input/interface/commands/base.ts`：`CommandContext` 移除 `rl` 字段
- `facade.ts`：`dispatchCommand` 调用处不再传入 `this.listener.getInterface()!`

### 决策 5：InputListener 增加双版本号可取消机制 [Amend 新增]

#### 5.1 resumeVersion — 预防过期 setImmediate 回调覆盖 isPaused

**选择**：给 `InputListener` 增加单调递增的恢复版本号（`resumeVersion`），使过期 `setImmediate` 回调无法错误覆盖 `isPaused` 状态。

- 新增内部字段 `private resumeVersion = 0`
- `pause()` 递增 `resumeVersion`
- `close()` 递增 `resumeVersion`
- `resume()` 的内部实现捕获当前 `resumeVersion` 到局部变量，setImmediate 回调执行时与当前 `resumeVersion` 比较
- 如果回调执行时的版本号与捕获时的版本号不一致，跳过恢复操作

**理由**：
- 当前 `resume()` 的 `setImmediate(() => { this.isPaused = false })` 不可取消，后续的任何 `pause()` 都无法阻止过期回调覆盖状态
- 版本号机制是最小侵入方案：仅新增一个数字字段，不改变 `InputListener` 的外部接口签名
- 零依赖，可在现有测试中直接覆盖

**替代方案**：
- `AbortController` / `AbortSignal`：方案正确但 `setImmediate` 不支持 `signal` 参数，需要额外包装。不引入额外复杂度理由成立

#### 5.2 readlineInstanceId — 防止旧 readline 延迟 line 事件穿透新实例

`rl.close()` 不能保证已排队的 `line` 事件停止触发（Node.js readline 文档明确说明）。旧 readline 实例的延迟 `line` 回调即使在新 `start()` 之后仍可能执行，且新老实例共享同一个 `this.isPaused` 字段。

**选择**：给 `InputListener` 增加 `rlInstanceId` 计数器，每个 `line` 回调闭包捕获创建时的实例 ID，执行时版本不匹配直接丢弃。

- 新增内部字段 `private rlInstanceId = 0`
- `start()` 在创建新 rl 之前递增 `rlInstanceId`，在闭包中捕获局部 `const instanceId = this.rlInstanceId`
- `close()` 递增 `rlInstanceId`，使所有已创建的 `line` 回调失效
- `line` 回调第一行检查：`if (instanceId !== this.rlInstanceId) return;`
- 在 `close()` 中显式 `this.rl?.removeAllListeners('line')` 解绑旧 handler，作为防御性补充
- `close()` 立即设置 `this.isPaused = true`

**理由**：
- 双版本号覆盖两个不同窗口：resumeVersion 拦截过期 setImmediate；rlInstanceId 拦截旧 readline 的延迟 line 事件
- 闭包捕获实例 ID 是 JS 惯用模式，零依赖
- `removeAllListeners('line')` 作为显式解绑的防御层

**影响**：`src/adapters/input/interface/io/input-listener.ts` 内部修改（双版本号 + removeAllListeners），不改变外部 API。
