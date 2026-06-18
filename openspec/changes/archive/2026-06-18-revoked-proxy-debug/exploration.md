# 探索主题: Immer 异步洋葱中间件 Proxy 撤销崩溃诊断

## 1. 问题定义
在执行一键磁盘清理评测脚本 `npx tsx test/scripts/run_testbed.ts` 时，智能体会话由于异步洋葱中间件的执行机制导致了 `TypeError: Cannot perform 'set' on a proxy that has been revoked` 的异常崩溃。该问题阻塞了整个生命周期事件的正常流转，急需制定安全、符合规范的修复方案。

## 2. 关键发现与调研结果
- **代码库现状**：在 [plugin-runner.ts](file:///d:/Projects/MyAgent/src/brain/plugins/plugin-runner.ts) 中，核心状态由 `asyncProduceWithPatches` 包装，在内部建立 Proxy 代理并异步调用洋葱模型 `await dispatch(0)`。
- **核实与洞察**：
  - Immer（项目版本为 `^11.1.8`）的 `produce` 和 `produceWithPatches` 是纯同步函数。
  - 通过强转将接收异步 recipe 的函数传给 `produceWithPatches` 时，一旦 recipe 在执行期间遇到第一个 `await` 微任务（例如等待审批挂起、异步插件执行等），recipe 立即暂停执行并向外部返回一个 Pending 状态的 Promise。
  - 此时，Immer 的同步 `produceWithPatches` 侦测到 recipe 执行结束，会在返回该 Promise 之前自动撤销（revoke）此 recipe 内部的所有 draft Proxy。
  - 当后续的异步微任务恢复执行并尝试通过沙箱化的 `sandboxedSessionContext` 进行 `addMessage` 或对 draft 进行任何写操作时，访问的正是已被撤销的 `draft` Proxy，从而导致了 `Cannot perform 'set' on a proxy that has been revoked` 崩溃。

## 3. 方案对比与推荐方向

| 评估维度 | 方案 A (推荐)：手动控制 Draft 生命周期 (`createDraft` / `finishDraft`) | 方案 B：重构所有中间件及审批流为纯同步模式，移去 `await` | 选型分析 |
| :--- | :--- | :--- | :--- |
| **开发与改造难度** | 极低 ✓<br>仅需调整 [plugin-runner.ts](file:///d:/Projects/MyAgent/src/brain/plugins/plugin-runner.ts) 一处的中间件驱动逻辑，不涉及其他模块。 | 极高 ✗<br>必须彻底推翻现有的异步插件、TracerLogPlugin、HumanApprovalPlugin 以及长生命周期的异步挂起设计。 | 方案 A 具有极高的可行性，几乎无改动成本。 |
| **异步支持能力** | 完美支持 ✓<br>可以在中间件和 recipe 执行过程中跨 Tick 等待任何异步网络请求、审批挂起等微/宏任务。 | 完全不支持 ✗<br>无法引入任何包含异步操作或长等待周期的逻辑，破坏了核心设计。 | 方案 A 原生兼容异步流转，方案 B 则彻底阻断了异步能力。 |
| **Immer 规范一致性** | 强 ✓<br>完全契合 Immer 官方针对跨 Tick、复杂的非同步场景（手动周期管理）的设计指南。 | 弱 ✗<br>虽然避开了异步生命周期问题，但却削足适履，限制了宿主代码本身正当的异步需求。 | 方案 A 是官方推荐的正确姿势。 |
| **安全性与稳定性** | 极高 ✓<br>Draft 不受微任务调度控制权交还的影响，直到中间件执行链全部就绪并调用 `finishDraft` 时才最终封冻并产生 Patch。 | 高 ○<br>避免了 Proxy 被撤销，但因为无法做异步等待，会引发更难排查的逻辑时序冲突。 | 方案 A 提供了稳定且优雅的状态隔离沙箱。 |

**推荐路径**：
采用 **方案 A**。
在异步洋葱分发前，同步调用 `createDraft(baseState)` 创建一个长期有效的 Draft，在异步的 `dispatch(0)` 执行结束后，再同步调用 `finishDraft(draft, (p) => patches.push(...p))` 来 Seal 冻结状态并捕捉 patches。
这既保留了 Immer 极佳的 Patch 捕捉与状态隔离设计，又完美支持了中间件内部的异步流程。

## 4. 约束、风险与未知项
- **脏写保护（并发冲突与状态覆盖风险）**：由于洋葱模型（`dispatch(0)`）的异步生命周期执行跨越了较长的物理时间（包括可能长达数分钟的人类审批挂起），在此期间如果系统有定时任务或其他外部并发事件直接修改了被传入 `createDraft` 的 `baseState`，最终执行 `finishDraft` 时就会使用陈旧上下文，覆盖掉期间产生的其他修改。
  - **规避手段**：必须在宿主级别引入状态锁（例如将 Session 标记为 busy 或 `isProcessing: true`），在洋葱圈开启至 `finishDraft` 完成之前，拦截或挂起任何其他非洋葱圈内的状态修改请求。
- **异常熔断与废弃处理**：在异步执行中间件或等待审批时，极有可能发生网络超时、用户拒绝审批、或系统主动中断等异常抛出。
  - **规避手段**：在 [plugin-runner.ts](file:///d:/Projects/MyAgent/src/brain/plugins/plugin-runner.ts) 中，必须使用稳固的 `try-catch-finally` 结构包裹整个 `dispatch(0)` 的异步分发过程。一旦流转过程中抛出任何异常，应当立即中断逻辑并废弃该 `draft`，坚决不调用 `finishDraft` 提交任何变更，从而防止错误的或残缺的 Patch 脏写落盘。

## 5. 否决方案
- **重构为纯同步中间件（方案 B）**：因 HumanApprovalPlugin 的挂起等待动作（例如用户在命令行或交互端审批）是固有的、跨越人类物理操作时间的异步逻辑，如果强制改为同步，将导致整个智能体在等待审批时同步阻塞 Node 进程或引发 CPU 忙等待，这在工程上是不可接受的。
