## 背景

在当前 `plugin-runner.ts` 的实现中，使用了强行声明为异步的 `asyncProduceWithPatches` 以包裹包含 `await` 异步控制权出让（如人机审批、异步中间件）的 recipe。由于 Immer 的 `produce` 在执行完首个同步 Tick 返回 Promise 瞬间即撤销了所有 draft Proxy，后续微任务再次访问沙箱状态时，直接触发了 `TypeError: Cannot perform 'set' on a proxy that has been revoked`。

此外，由于中间件流程在引入人机审批后成为了跨越较长物理时间的异步操作，需要针对并发状态脏写进行拦截防御，并确保任意中间件执行异常时能安全熔断不脏写状态。

## 目标与非目标

**目标:**
- 解决在生命周期 Hook 异步流转中因 Immer 代理提前被销毁导致的 Revoked Proxy 崩溃。
- 引入 Session 级别的忙状态并发锁，拦截或挂起在异步洋葱圈管道流转期间，外部其他非洋葱圈并发任务直接对宿主 `SessionContext` 进行的消息修改。
- 建立稳固的异常熔断机制，在中间件运行抛出异常时直接熔断流转、释放状态锁，并且不向宿主提交任何残缺的变更。

**非目标:**
- 将 `HumanApprovalPlugin` 审批插件或其他异步可观测性中间件重构为纯同步逻辑。
- 升级或修改第三方库 Immer 依赖版本。
- 修改除了 [plugin-runner.ts](file:///d:/Projects/MyAgent/src/brain/plugins/plugin-runner.ts) 和 [context.ts](file:///d:/Projects/MyAgent/src/brain/context.ts) 之外的其他系统核心文件。

## 架构决策

### 决策 1：手动托管状态 Draft 生命周期
- **内容**：废弃 `asyncProduceWithPatches` 异步欺骗声明，直接引入 Immer 提供的 `createDraft(baseState)` 与 `finishDraft(draft, patchListener)` 接口。
- **机制**：
  - 在异步洋葱圈调用前，同步通过 `const draft = createDraft(baseState)` 创建出在异步微任务 Tick 之间持续有效的沙箱 Draft。
  - 在异步洋葱模型 `await dispatch(0)` 顺利完成后，再同步调用 `finishDraft` 结束并封冻 Draft，生成最终状态和 Patch，从而完美消除生命周期微任务出让导致 Proxy 提前 Revoked 的问题。

### 决策 2：SessionContext 忙状态并发锁 (Busy State Lock)
- **内容**：在 [context.ts](file:///d:/Projects/MyAgent/src/brain/context.ts) 中增加状态并发修改锁。
- **机制**：
  - 在 `SessionContext` 类中定义公共属性 `public isProcessing = false;`。
  - 在 `addMessage`、`popMessage`、`truncateHistory`、`updateHistory` 以及 **`updateSystemPrompt`**、**`loadState`** 等宿主修改状态的方法入口添加断言：
    ```typescript
    if (this.isProcessing) {
      throw new Error('Cannot modify SessionContext: session is currently busy processing hooks.');
    }
    ```
  - 在 [plugin-runner.ts](file:///d:/Projects/MyAgent/src/brain/plugins/plugin-runner.ts) 中，洋葱分发开始前置 `sessionContext.isProcessing = true`。
  - 由于沙箱代理 Proxy 拦截了 `sandboxedSessionContext` 的写操作，重定向到对 `draft.history` 的直接变异，因此中间件内的写操作不会触发宿主上的 isProcessing 报错，保证了沙箱的封闭性。
  - `[Amend 修正]`：废弃之前通过临时修改 `sessionContext.isProcessing = false` 绕过锁提交的设计。因为洋葱圈执行是由包含 `finally` 的 try-catch 块控制的，在执行落盘逻辑时，`finally` 已经执行并解开了忙状态锁，因此无须任何额外解包包装，直接调用底层的 `sessionContext.updateHistory(finalState.history)` 即可。

### 决策 3：异常捕获熔断与安全释放
- **内容**：使用强健的 `try-catch-finally` 包裹整个洋葱递归分发过程。
- **机制**：
  ```typescript
  try {
    sessionContext.isProcessing = true;
    await dispatch(0);
    // 将中间件中填写的尾随工具请求与控制指令提取到最终合并状态中
    draft.tailToolCallRequest = sandboxContext.tailToolCallRequest;
    // 只有在全部成功后才 finishDraft
    const finalState = finishDraft(draft, (p) => patches.push(...p));
  } catch (error) {
    // 抛出异常时不 finishDraft 提交变更，安全废弃 Draft，防止残损 patch 脏写
    console.error(`[Plugin Error] Hook ${eventName} failed:`, error);
    throw error;
  } finally {
    // 保证锁在异常流转后也能妥善释放
    sessionContext.isProcessing = false;
  }

  // 此时锁已安全释放，直接落盘提交修改
  if (finalState.history !== baseState.history && context.control.action !== 'abort') {
    sessionContext.updateHistory(finalState.history);
  }
  ```

## 风险与权衡

- **死锁风险**：如果 `finally` 块未能正确重置 `isProcessing = false`，将导致该 Session 永远处于锁死状态。
  - **缓解策略**：使用极其可靠的 `finally` 块，确保在退出 `runHookPipeline` 时一定会将 `sessionContext.isProcessing` 还原为 `false`。
- **并发锁报错抛出中断外部定时任务**：如果外部有非阻塞的后台任务在智能体执行期间试图写入 Session 历史，将会被抛错中断。
  - **缓解策略**：该报错是保障数据一致性的必要保护。外部业务代码在设计并发任务时应当感知 `isProcessing` 的忙状态，合理安排重试或在此期间挂起自己。
