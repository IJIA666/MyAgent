# 探索主题: 人机协同审批流拦截器 (Human-in-the-Loop)

## 1. 问题定义
当前智能体通过 `terminal-engine.ts` 拥有直接执行物理终端命令的高权限能力。虽然 `terminal-guard.ts` 做了正则表达式拦截（防拼接注入）和执行目录越界检查，但缺乏更高维度的意图阻拦和统一的审批流机制。若大模型产生毁灭性指令（如 `rm -rf /*`），或者未来引入其他高危工具（如直接修改/删除文件），现有的分散在工具内部的 `askUserPermission` 会导致代码冗余且无法被外层调度器统一管理，悬在头顶的“达摩克利斯之剑”亟待一个系统级的拦截架构。

## 2. 关键发现与调研结果
- **代码库现状**：
  1. `agent-loop.ts` 已经实现了非常完善的洋葱圈管道插件机制（`BeforeTool` 等生命周期 Hook），目前已挂载 `TokenWatermarkPlugin`、`LoopPreventionPlugin` 等底层插件，具备极强的拦截干预能力。
  2. 交互逻辑高度耦合：当前的 CLI 审批逻辑（`askUserPermission`，基于 `readline`）被硬编码在了 `action/native-tools/terminal.ts` 的 `executeCommandTool` 中。这不仅违背了工具模块的单一职责（工具应该只负责执行），且使得非终端类的危险操作无法复用该审批能力。
  3. 现有的 `HookControl` 仅支持 `continue`、`restart`、`abort` 三种状态，不支持“暂停并等待”语意。由于 `AgentLoop.chat` 是一个 `AsyncGenerator`，目前缺乏将挂起状态透传给 UI 层（CLI 或 Web）并接收恢复信号的通道。
- **核实与洞察（含竞品 Claude Code 调研）**：
  构建统一的 Human-in-the-Loop 是工业级 Agent 框架的标准做法（如 LangGraph 的 interrupt/resume，或 OpenAI 的 requires_action 机制）。

  **针对 `Agents/claude-code` 的深度源码剖析：**
  在调研了 Claude Code 的源码（主要集中在 `toolHooks.ts`、`useCanUseTool.tsx` 与 `interactiveHandler.ts`）后，我发现它的实现逻辑与我们的**方案 B**高度重合：
  1. **基于状态机的洋葱圈拦截**：在 `runPreToolUseHooks` 阶段，其插件可以返回 `allow`、`ask` 或 `deny`。
  2. **Promise 强制阻塞**：当状态为 `ask` 时，`useCanUseTool` 会返回一个未 resolved 的 Promise，强行阻塞当前工具的执行线程。
  3. **同进程的 UI 渲染唤醒**：Claude Code 的 CLI 界面基于 React Ink 开发，它将拦截事件推送至全局的 `ConfirmQueue`，React 重新渲染弹出交互界面，用户选择后调用回调执行 `resolveOnce()`，唤醒被阻塞的 Promise。

  **针对 `Agents/openclaw` 的深度源码剖析：**
  OpenClaw 采用了与 Claude Code 截然不同的**“非阻塞、基于队列与事件的异步审批（方案 C）”**：
  1. **直接拦截与拒绝**：在 `invoke-system-run.ts` 中，当安全策略要求审批时，系统不会挂起线程，而是直接放弃执行，并向外发送 `exec.denied` 等事件，同时在底层（如数据库或内存）创建一条 `ExecApprovalRequest` 记录。
  2. **端侧轮询与独立队列**：UI 端（如 `exec-approval.ts` 控制器）会通过 `exec.approval.list` 接口主动拉取挂起的审批请求（或通过 WebSocket 接收推送），并在界面上渲染队列。
  3. **重试机制**：用户在 UI 点击通过后，通过专门的 Gateway API 解决该 Approval，并附带 `allow-once` 等决策，代理随后可带着这个特权决策重试该命令。

  **针对 `Agents/opencode` 的深度源码剖析：**
  OpenCode 的实现可以说结合了方案 A 和方案 B 的优点，它是基于 **Effect-TS 响应式异步框架** 实现的：
  1. **事件触发与 Fiber 挂起**：在 `packages/opencode/src/permission/index.ts` 中，当拦截器判断需要 `ask` 时，它会创建一个 `Deferred` (Effect-TS 的异步凭证)，对外广播一个 `Permission.Asked` 事件，然后通过 `yield* Deferred.await(deferred)` 将当前执行工具的 Fiber（轻量级协程）彻底挂起。
  2. **事件解耦的表现层**：无论是其自带的 TUI（终端 UI）还是桌面端，都会监听 `Permission.Asked` 事件并在前台渲染审批弹窗。此时，底层的 Agent 协程正在安静地等待。
  3. **回复与唤醒**：用户操作后，UI 调用底层的 `Permission.reply` 接口，该接口内部会执行 `Deferred.succeed` 或 `Deferred.fail`，从而精确唤醒那个被挂起的协程继续执行。

  **针对 `Agents/hermes-agent` 的深度源码剖析：**
  Hermes 是一款基于 Python 的 Agent 框架。由于 Python 原生的并发模型特点（缺乏真正的多核无栈协程环境，通常采用线程池），它走了一条经典的**“系统线程阻塞式挂起（多线程环境下的方案 B 变体）”**：
  1. **基于 `threading.Event` 阻塞 OS 线程**：在 `tools/approval.py` 中，当触发危险命令拦截时，网关环境会为当前请求生成一个 `_ApprovalEntry` 并放入 `_gateway_queues` 中。这个 Entry 内部封装了一个 Python 的标准 `threading.Event()`。随后，正在执行大模型推理的这个底层工作线程就会直接调用 `wait()` 或被 `join()`，导致该原生 OS 线程彻底休眠挂起。
  2. **网关回调下发 UI**：挂起前，系统会调用预先注册的 `_gateway_notify_cbs` 回调，将拦截消息扔给网关/API 服务器异步发送给前端。
  3. **并发唤醒**：用户在前端确认后，网关 API 收到请求，调用 `resolve_gateway_approval`，设置用户决策（`choice`）并执行 `event.set()`，操作系统随后唤醒那个沉睡的工作线程继续向下执行。

  **借鉴意义与反思**：
  将四大开源框架梳理完毕后，我们发现业界的所有实现思路在底层逻辑上无非这三个派系：
  - **派系 1：强依赖语言机制在原地挂起执行流**（Claude Code 的 Promise 挂起、OpenCode 的 Fiber 协程挂起、Hermes Agent 的原生 OS 线程挂起）。
  - **派系 2：失败+外置状态机的重试流**（OpenClaw 的阻断返回 + UI 写入特权状态后发起的轮询重试）。
  
  而我们目前的底层环境是纯原生 ES6 `AsyncGenerator`。单纯在 AgentLoop 内部实现 `suspend` 状态机（原始**方案 A**）虽然解耦，但会造成极其严重的业务逻辑向调度层泄露，且无法利用插件本身的闭包优势处理后置逻辑。

## 3. 终局方案：进化版“方案 B++”（事件挂起与 Promise 等待）
经过对方案 A 局限性的深思熟虑，结合 OpenCode 等开源项目的灵感，我们决定采用基于原生 JS 的 **方案 B++**：
将“挂起等待”的具体决策和后置处理（如写入白名单）完全闭包在插件中间件内部。大循环 `AgentLoop` 对“挂起”这一具体业务毫不知情，它只是在 `await runHookPipeline` 时被 JS 的事件循环机制天然挂起。

### 核心思想
1. 插件 `HumanApprovalPlugin` 嗅探高危命令，若触发拦截，广播 `emitEvent({ type: 'suspend', id, toolCall })` 通知外部 UI 渲染弹窗。
2. 插件随即调用 `await ApprovalService.wait(id)` 阻塞自己，让出执行权。此时 AgentLoop 也会被自然挂起，完全不占用 Node.js 主线程资源。
3. 外部 UI（Web / CLI）拿到用户的选择后，调用 `ApprovalService.resolve(id, decision)`。
4. 插件的 `await` 被唤醒，自行完成白名单持久化，随后执行 `await next()`，大循环继续运转。

### 方案对比评估
| 评估维度 | 方案 A：扩展 HookControl 支持 `suspend` 状态 | 方案 B++（最终采纳）：在插件内通过 Service 挂起 | 选型分析 |
| :--- | :--- | :--- | :--- |
| **大循环侵入性** | 高 ✗。需改写 AgentLoop 状态机以支持 suspend 动作并处理挂起。 | **零侵入 ✓**。利用 `await next` 天然的异步等待机制，AgentLoop 无需感知挂起逻辑。 | B++ 完胜 |
| **业务内聚性** | 低 ✗。白名单写入、单次/多次审批分支处理被迫泄漏到大循环中。 | **极高 ✓**。高危命令的判断、白名单自动录入、短路控制全部内聚在插件中。 | B++ 完胜 |
| **多端解耦性** | 强 ✓。通过 AgentEvent 广播 suspend 状态。 | **强 ✓**。通过 `HookContext.emitEvent` 广播 suspend，外部 UI 统一监听并渲染。 | 平手 |
| **内存防悬空** | 一般 ✗。需要在 AgentLoop 内部实现超时逻辑。 | **极佳 ✓**。由 `ApprovalService` 集中统一管控 Promise 的生命周期及超时自动拒绝。 | B++ 完胜 |

## 4. 实施计划 (Proposal)
1. **新增 `ApprovalService` 服务**：提供 `wait()` 挂起并在内部封装 5 分钟超时防悬空逻辑，提供 `resolve()` 供外部唤醒。
2. **扩展 `SessionContext` 与事件流**：引入 `ApprovalService` 实例，扩展 `AgentEvent` 新增 `suspend` 类型。
3. **编写 `HumanApprovalPlugin` 插件**：利用正则表达式嗅探 `rm -rf` 等危险命令，执行 `emitEvent` 与 `await wait()` 的挂起逻辑。
4. **工具层去耦合**：彻底移除 `terminal.ts` 中的 `readline` 与交互逻辑，让工具回归纯无状态执行流。

## 5. 边缘与缺陷场景分析
**场景 A：在大并发 tool_calls 下的时序和死锁防范**
当大模型返回多个危险的 `tool_calls` 时，`AgentLoop` 是在一个 `for` 循环中串行运行它们的 `BeforeTool` 钩子的。在方案 B++ 中，第一个工具会在它的 `BeforeTool` 中间件里 `await approvalService.wait`。因为是串行 `await`，第二个工具根本还没进入 `BeforeTool` 阶段，会在外层排队。
**设计结论**：串行处理是绝对安全的，天然不会发生多工具争抢导致事件冲突或渲染死锁。

**场景 B：单元测试环境中的 Bypass 与 Mock**
在编写单元测试（非交互式 / CI 环境）时，如果没有真实的 UI 宿主来 resolve 审批，所有测试的终端执行命令都会卡死在 wait 或因为超时被拒绝。
**设计结论**：需要在 `ApprovalService` 中支持自动放行模式。例如在测试环境中注入一个 `mockDecision`，或者当检测到环境无需 UI 时，`wait` 立即返回一次性允许（`once`），以保证既有测试链路不中断。

**场景 C：多端兼容下的内存释放与清理**
如果 Web 端的 WebSocket 在挂起期间意外断开，Web 宿主将不再会调用 resolve。
**设计结论**：虽然在 `wait` 里设置了 5 分钟超时兜底（超时自动 resolve deny），但在超时前，我们需要保证若宿主明确知道连接已断开，能够主动调用 `approvalService.rejectAll()` 或主动 `resolve(id, { action: 'deny' })` 来立刻释放资源。

## 6. 否决方案
- **直接在 Terminal 工具内部继续魔改**：被舍弃。无法覆盖到未来其他有风险的工具（如 API 变更、DB 截断），使得底层执行器与表现层 UI 死死绑定。
- **原始的方案 A (`AgentLoop` 内部控制流处理)**：被舍弃。会导致极度糟糕的多并发工具弹窗体验，且打破了洋葱圈插件生命周期的连贯性。
