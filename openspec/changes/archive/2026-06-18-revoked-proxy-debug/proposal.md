## 改造原因

智能体在执行一键磁盘清理评测脚本 `npx tsx test/scripts/run_testbed.ts` 时，于 SessionStart 生命周期事件流转完毕的瞬间发生崩溃退出，抛出 `TypeError: Cannot perform 'set' on a proxy that has been revoked` 异常。

经排查，该崩溃的根本原因为 `plugin-runner.ts` 强行使用了包装为异步的 `asyncProduceWithPatches`。由于 Immer 本身的 `produce` 与 `produceWithPatches` 是纯同步机制，在遇到洋葱插件中间件的第一个 `await` 异步微任务挂起（如等待人机审批）时，recipe 函数暂停并返还控制权，导致 Immer 同步退出的瞬间立刻撤销（revoke）了所有的 draft Proxy。在此之后，恢复执行的异步微任务通过沙箱 SessionContext 写入状态时，因访问了被撤销的 Proxy 而遭遇崩溃。

因此，需要在保持中间件异步分发能力（尤其是人机审批挂起）的前提下，重构状态更新机制，彻底解决 Revoked Proxy 崩溃，并引入相应的并发脏写保护和异常熔断防护。

## 变更内容

1. **生命周期手动托管**：废弃 `asyncProduceWithPatches` 强转形式。在 [plugin-runner.ts](file:///d:/Projects/MyAgent/src/brain/plugins/plugin-runner.ts) 的洋葱链分发前，改用 Immer 官方提供的 `createDraft` 手动创建一个在异步微任务周期内长期有效的 Draft，在异步洋葱执行链全部正常完成后，同步调用 `finishDraft` 冻结状态并捕获 Patch。
2. **并发锁脏写保护**：在洋葱链开启到 `finishDraft` 结束期间，由于跨越了时间线（属于异步长周期操作），必须在 Session 级别或宿主级别引入状态锁，拦截或挂起任何非洋葱管道内发起的并发状态修改请求，防止 Stale Draft 覆盖最新状态。
3. **异常熔断与安全废弃**：使用 `try-catch-finally` 包裹 `dispatch(0)` 的整个执行链。若流转过程中发生超时、用户拒绝审批或其他任意异常抛出，直接废弃该 Draft 并不调用 `finishDraft` 提交，保证坏账不落盘。

## 业务能力

### 新增业务能力
- 无

### 修改业务能力
- 无

## 影响范围

- **受影响文件**：[plugin-runner.ts](file:///d:/Projects/MyAgent/src/brain/plugins/plugin-runner.ts)。
- **系统影响**：作为智能体 Hook 管道运行调度器，本变更将直接影响所有生命周期 Hook 插件（如 TracerLogPlugin、JitRulesPlugin、HumanApprovalPlugin）的加载与上下文安全运行，提高智能体会话状态流转与可观测性 Patch 审计的整体稳定性。
