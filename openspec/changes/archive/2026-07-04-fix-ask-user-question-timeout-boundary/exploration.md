# 探索主题: ask_user_question 等待时间被错误计入工具超时

## 1. 问题定义

在 2026 年 7 月 4 日的真实会话中，用户在 CLI 提问界面停留稍久后，`ask_user_question` 没有继续等待用户选择，而是被系统直接判定为“工具执行超时熔断阻断”。这不是简单的交互体验瑕疵，而是一个明确的运行时语义错误：**人机等待时间被错误地算进了通用工具执行超时预算**。该行为与现行 OpenSpec、CLI 交互层实现注释以及手动测试文档对“默认 5 分钟提问超时”的描述相互冲突。

## 2. 关键发现与调研结果

- **代码库现状**：
  - `src/adapters/input/interface/interaction-handler.ts` 明确将提问等待超时设置为默认 `300_000ms`（5 分钟），并在超时后输出”⏰ 提问等待超时，自动跳过。”。
  - `openspec/specs/ask-user-question/spec.md` 也明确规定：用户长时间未响应时，默认 5 分钟后返回空字符串。
  - 但 `src/core/usecases/engine/agent-loop.ts` 会对**所有工具调用**统一注入 `AbortController`，其超时预算来自 `runtimeLimits.toolTimeoutMs`。
  - `src/config/loader.ts` 中 `toolTimeoutMs` 的默认值为 `30000ms`（30 秒）。
  - 因此 `ask_user_question` 虽然内部声称支持 5 分钟等待，但实际上在大约 30 秒后就会被外层统一工具超时熔断提前中止。
- **真实日志证据**：
  - 会话日志 `.myagent/sessions/session_20260704T135156.785Z-b571b256-20ab-4047-a0c6-1f6086a78c2b.json` 中，第二次 `ask_user_question` 调用的工具返回值不是”用户回答”也不是”5 分钟超时自动跳过”，而是直接记录为：`工具执行超时熔断阻断: 工具执行已被 Abort 阻断（超时）`。
  - 这说明本次失败并非 `InteractionHandler` 自己的 5 分钟计时器先触发，而是更外层的通用工具超时先触发。
- **完整调用链路**（每一步的时序竞争）：
  1. `agent-loop.ts:505-509`：创建 `AbortController`，`timeoutMs = runtimeLimits.toolTimeoutMs ?? 30000`，30 秒后自动 `controller.abort()`
  2. `agent-loop.ts:873`：`controller.signal` 传入所有 `executeToolTask(idx, tc, controller.signal)`
  3. `agent-loop.ts:692`：`→ toolRegistry.callTool(..., signal)`
  4. `toolRegistry.ts:93-96`：`→ localMcpServer.callTool(..., signal)`
  5. `virtual-mcp.ts:321`：`→ tool.execute(args, ctx, signal, interactionPort)`
  6. `ask-user-question.ts:88`：`→ interactionPort.askUser(payload, signal)`
  7. `interaction-handler.ts:78`：`signal?.addEventListener('abort', onAbort)`
  - **30 秒后**：`controller.abort()` → `InteractionHandler` 收到 abort → 返回空字符串 → agent-loop:711 检测到 `signal.aborted` → 抛出 `”工具执行已被 Abort 阻断（超时）”`
  - **`InteractionHandler` 的 5 分钟计时器（第 27 行 `300_000ms`）从未有机会触发**
- **竞品调研结果**（本地源码根目录：`D:\projects\Agents`）：

  ### Claude Code（编码 Agent）—— `requiresUserInteraction` 标记 + 权限流程分离

  Claude Code 对交互工具和普通工具采用**完全不同的执行路径**：

  - `AskUserQuestionTool.tsx` 中，工具本身显式声明 `shouldDefer: true`（第 113 行）、`requiresUserInteraction(): true`（第 155-157 行）
  - 同一工具的 `checkPermissions()` 只返回 `{ behavior: 'ask', message: 'Answer questions?' }`（第 182-186 行），真正的人机等待不在 `call()` 内部完成
  - `call()`（第 209 行起）只负责把已经收集好的 `questions/answers/annotations` 回传，几乎是瞬时完成
  - `interactiveHandler.ts` 顶部注释明确写着：“This function does NOT return a Promise”（第 53-55 行），说明交互阶段不是一个普通同步工具 Promise
  - 同一处理器通过 `createResolveOnce(resolve)` + `claim()`（第 70 行）防并发竞争，`resolveOnce(...)` 只在用户允许、拒绝、中断或外部回调到达时触发；当前读取到的这条主交互路径中**没有为 ask_user_question 单独设置固定等待超时**
  - 结论：Claude Code 的核心边界是**交互等待先于工具真正执行完成**，而不是“工具执行中顺便等人”

  **核心代码路径**：
  ```
  agent-loop → checkPermissions(弹对话框, 无限等待)
                    ├─ onAllow: 用户确认 → resolve
                    ├─ onReject: 用户拒绝 → resolve
                    ├─ onAbort: Esc → resolve
                    └─ recheckPermission: 权限变更自动放行 → resolve
                → tool.call(瞬时完成) → 继续 agent 循环
  ```

  ### OpenCode（编码 Agent）—— `Deferred` 发布/订阅模式

  OpenCode 使用 **Effect-TS 的 `Deferred` 原语**将工具执行与用户回复彻底解耦：

  - `packages/core/src/tool/question.ts` 里，问题工具先经过 `permission.assert(...)`，再调用 `question.ask(...)`（第 14-17 行、第 57-70 行）
  - `packages/core/src/question.ts` 中，`ask()` 会 `Deferred.make()`（第 97 行）、`pending.set(...)`（第 99 行）、发布 `Event.Asked`（第 100 行），随后 `Deferred.await(...)`（第 101 行）等待外部回复
  - 用户回复通过 `reply()` 进入，最终 `Deferred.succeed(...)`（第 122 行）唤醒；拒绝则 `Deferred.fail(...)`（第 137 行）
  - 这条链路同样**没有统一的 30 秒/5 分钟等待超时**；等待何时终止由业务层的 reply/reject 或外部显式取消决定

  **核心代码**（`question/index.ts:87-112`）：
  ```typescript
  const deferred = yield* Deferred.make<...>()
  pending.set(id, { info, deferred })
  yield* events.publish(Event.Asked, info)
  return yield* Deferred.await(deferred)  // 阻塞，直到外部 reply()
  ```

  ### Hermes Agent / OpenClaw（通用 Agent）

  两个通用 Agent 未在核心引擎层面对 `ask_user_question` 做超时差异化处理。`ask_user_question` 仅在 skill 文档中被引用（如漫画生成器的角色选择），用户交互被视为”对话流自然组成部分”而非”工具调用的同步阻塞”。**参考价值有限。**

  ### 竞品架构对比

  | 维度 | MyAgent（当前） | Claude Code | OpenCode |
  |------|----------------|-------------|----------|
  | 交互工具标记 | ❌ 无，所有工具平等对待 | `requiresUserInteraction(): true` | Deferred（隐式） |
  | 工具超时机制 | 统一 AbortController 30s | 交互阶段不走统一工具超时 | Deferred 无统一超时 |
  | 交互等待位置 | 工具 `execute()` 内部同步 | `checkPermission()` 阶段（工具执行前） | 事件发布后异步等待 |
  | 超时值配置 | `toolTimeoutMs=30s` 覆盖一切 | N/A（用户主动决定） | N/A（Effect 运行时） |
  | 人机边界 | 混乱：人等 = 工具等 = 30s | 清晰 | 清晰 |
  | 与 OpenAI 最佳实践一致性 | ❌ | ✅ | ✅ |

- **核实与洞察**：
  - OpenAI 官方在 [Background mode](https://developers.openai.com/api/docs/guides/background) 中明确把”长时间运行任务”与”避免 timeout / connectivity issues”绑定处理，说明长等待不能简单塞进短生命周期同步执行里。
  - OpenAI 官方在 [Guardrails and human review](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals) 中明确写道：human review “pauses the run”（第 723-726 行），审批场景的标准生命周期是“记录 interruption → 返回 resumable state → 应用批准/拒绝 → 从同一 state 恢复同一 run”（第 1049-1056 行、第 1068 行）。
  - 这意味着：**主流做法不是“给人类等待再配一个更大的 timeout”**，而是把“等待人”建模成 run interruption / deferred reply / paused state。
  - 基于以上源码与联网核实，可以确认：当前实现不是单纯参数没调好，而是**运行时边界划分错误**。`ask_user_question` 代表的是”等待人类协作”，不是普通的短时工具执行。更进一步说，现行 spec 中“默认 5 分钟超时”本身也不是最佳设计。

## 3. 方案对比与推荐方向

| 评估维度 | 方案 A：仅让 ask_user_question 脱离通用工具超时，但仍在工具 Promise 内等待 | 方案 B：显式 interruption + resumable state，把“等待人”从工具执行中分离 |
| :--- | :--- | :--- |
| 修复速度 | 快，改动小，可立即止血 | 中到慢，涉及 agent-loop、状态保存与 CLI 恢复路径 |
| 是否修复 30 秒误判超时 | 能 | 能 |
| “用户选择默认不超时”能否成立 | 能，但仅限进程存活期间 | 能，且语义完整 |
| 架构语义是否正确 | 一般。仍把”等人”塞在同步工具调用中 | 强。人与工具的等待边界被彻底分离 |
| 会话/进程中断后的恢复能力 | 弱。进程退出即丢失等待态 | 强。可以保存 interruption state 后恢复 |
| 后续扩展性 | 弱。审批、提问、延迟确认会继续分叉实现 | 强。所有 human-in-the-loop 场景可统一收敛 |
| 与官方最佳实践一致性 | 中 | 高 |
| **与竞品一致性** | 只学到 Claude Code 的标记分离 | 同时吸收 Claude Code 的交互分流与 OpenCode 的 deferred reply |

**推荐路径**：最佳方案应当是 **方案 B**，方案 A 仅作为短期止血，不应被视为最终架构。

1. **统一抽象：把 `ask_user_question` 从“普通工具执行”提升为 “human interruption”**
   - 不再只用 `securityCategory: 'read' | 'write'` 区分工具。
   - 在 `NativeTool` 或等价元数据层新增更强语义字段，例如：
     ```typescript
     readonly executionMode?: 'immediate' | 'human_interruption';
     ```
   - `ask_user_question` 标记为 `human_interruption`。后续如果出现“文件确认”“风险说明后继续”“浏览器登录等待”等交互，也复用同一语义，而不是继续堆特判。

2. **agent-loop 语义调整：human interruption 不进入通用 `toolTimeoutMs` 预算**
   - 普通工具仍使用现有 `AbortController + toolTimeoutMs`。
   - `human_interruption` 工具不走当前“执行中同步等待”的超时路径，而是在触发点生成一个 interruption 记录并暂停 run。
   - 这一步是关键边界：**等待人类不是工具卡住，而是 run 合法暂停。**

3. **状态模型：返回 interruption 记录与 resumable state，而不是直接等在 Promise 里**
   - 参考 OpenAI 官方生命周期：记录 interruption，返回 resumable state，待用户批准/回答后从同一 state 恢复同一 run。
   - 对 MyAgent 而言，至少应在 session 持久化结构中记录：
     - `pendingInteraction.id`
     - `pendingInteraction.toolCallId`
     - `pendingInteraction.kind`（如 `question` / `approval`）
     - `pendingInteraction.payload`
     - `pendingInteraction.createdAt`
   - 这样即使后续要支持“晚一点再答”“重启后恢复”，状态模型也不需要推倒重来。

4. **默认策略：用户选择默认无超时；终止条件改为显式取消或会话生命周期事件**
   - `ask_user_question` 默认**不设置自动超时**。
   - 合法终止条件应改为：
     - 用户明确取消（Esc / Ctrl+C / UI dismiss）
     - 会话关闭
     - 进程退出
     - 上层业务显式设置了可选 `expiresAt` / `timeoutMs`
   - 如果未来某些问题确实需要 deadline，也应由调用方显式声明，而不是框架默认 5 分钟。

5. **审批与提问统一底座，但策略分层**
   - 底层都走 interruption / resolve / resume 机制。
   - 但策略不必完全一致：
     - `ask_user_question`：默认无超时
     - `approval`：可继续保留可配置兜底超时，因为它属于安全控制，不同于协作式提问
   - 这样既统一了基础设施，又保留了语义差异。

6. **短期止血（仅过渡，不是终局）**
   - 如果必须先快速修 bug，可临时引入 `requiresUserInteraction` 或等价标记，让 `ask_user_question` 脱离 30 秒统一工具超时。
   - 但即使这样，默认也不应再绑定 5 分钟自动跳过；最多只应去掉通用工具超时，让等待由显式取消结束。
   - 该方案只能作为过渡，因为它仍然缺少“state / interruption / resume”的正交边界。

## 4. 约束、风险与未知项

- 当前文件**只聚焦一个边界**：`ask_user_question` 的等待超时语义错误，不扩展讨论 Plan 模式整体 UX、C 盘诊断幻觉、审批体系重构等其他独立问题。
- 即使短期采用“脱离通用超时”止血，仍会遗留一个架构性风险：只要未来再加入其他“等待人类”的工具，就会再次面临到底算工具超时还是算 run 暂停的问题。
- 现有 spec 还要求支持 `multiSelect: true` 的多选界面，但当前 CLI 渲染层未见对应分支。该问题与本文件主题不同，但说明 `ask_user_question` 整体完成度仍需继续审视。
- 需要后续确认：审批链路当前是否也存在与 `toolTimeoutMs` 的类似冲突，只是尚未在真实会话中充分暴露。
- 竞品参考的适用性边界：Claude Code 的 `requiresUserInteraction` 标记机制与其 Ink 渲染架构深度绑定；OpenCode 的 Deferred 模式依赖 Effect-TS 运行时。直接照搬不可行，但**标记分离**的架构思想可跨架构复用。

## 5. 否决方案

- **否决方案 1：仅修改文档，把默认 5 分钟改成 30 秒**：这会掩盖真实问题，而不是修复问题。用户交互等待被算进通用工具超时，本质上仍然错误。
- **否决方案 2：继续维持现状，要求用户 30 秒内必须完成选择**：这既不符合当前 spec，也不符合真实人机协作场景，尤其在用户需要阅读较长分析结果后再做决策时几乎必然踩坑。
- **否决方案 2.5：把 30 秒改成 5 分钟就算修复完成**：这只是把错误边界延后触发，不是把“等待人类”从“普通工具超时”中分离出去。
- **否决方案 2.6：给 `ask_user_question` 继续保留默认 5 分钟自动跳过**：对于用户主动选择题，这个默认值本身就缺乏语义正当性。选择题默认应等待用户明确回答或取消，而不是框架代替用户超时作废。
- **否决方案 3：把这个问题与“模型会瞎猜 C 盘占用”打包成一个大而全的探索文件**：两者可独立验证、独立修复，强行捆绑会破坏探索边界，降低后续变更闭环质量。
