## 1. InputListener 依赖注入与流解耦重构

- [x] 1.1 重构 [input-listener.ts](file:///d:/Projects/MyAgent/src/interface/io/input-listener.ts) 中的 `InputListenerOptions` 接口，新增可选的 `input?: NodeJS.ReadableStream` 和 `output?: NodeJS.WritableStream` 属性。
- [x] 1.2 重写 `InputListener` 中的内部属性及 `start()` 方法中 `createInterface` 实例的创建参数，使其优先使用外部注入的 `input` 与 `output` 流，解耦对全局 `process.stdin` / `process.stdout` 的硬强绑定。**注意避雷：**必须同步重构 `triggerEscDoublePress()` 内部临时创建的 `tempRl`，以及第 212 行 `process.stdout.write` 的物理擦除动作，全量替换为注入的流！
- [x] 1.3 调整 [facade.ts](file:///d:/Projects/MyAgent/src/interface/facade.ts) 构造函数中实例化 `InputListener` 的代码，确保不传流参数时默认无损回退至全局物理进程流，验证正常开发运行无差错。

<!-- checkpoint: npm run build -->

## 2. 交互层与状态让渡单元测试用例补齐

- [x] 2.1 新建单元测试文件 `test/interface/input-listener.test.ts`。在测试套件中实例化 Mock 流（手动劫持并仿真 `isTTY = true` 属性）并注入，利用 Promise 事件驱动包装（完全废弃 `nextTick`/`setTimeout` 盲等）编写常规启动、按键回显动作 of 按键回显动作的断言。
- [x] 2.2 编写 Stdin 挂起拦截与防缓冲区积压用例。验证挂起期间向 Mock 可读流推入的数据均被物理阻断；且在后续调用 `resume()` 恢复后，额外断言没有任何在挂起期间输入的垃圾数据被错误触发，确保内部缓冲区状态物理洁净。
- [x] 2.3 编写职责解耦与物理重建用例。验证 `InputListener.close()` 仅注销内部 readline 且**绝不物理销毁**外部传入流本身（流生命周期释放权归属于单测 `afterEach` 控制），断言重建 `start()` 能够顺利在原流上继续工作，且在 `afterEach` 钩子中物理销毁 mock 流以防御测试悬挂。

<!-- checkpoint: npm run test -->

## 3. ApprovalService 审批组件单元测试覆盖

- [x] 3.1 新建单元测试文件 `test/brain/ApprovalService.test.ts`。编写 **Bypass 模式短路测试**：验证在 `isBypassMode = true` 时调用 `wait()` 会同步返回 `{ action: 'once' }`，且不触发任何定时器和事件回调。
- [x] 3.2 编写 **事件分发与挂起唤醒测试**：验证调用 `wait()` 后正确触发 `onNeedApprovalHandler` 回调；随后外部调用 `resolve()` 时，挂起的 Promise 能被正确唤醒并收到对应决策，且定时器被清理。
- [x] 3.3 编写 **超时与批量拒绝防泄漏测试**：利用 `vi.useFakeTimers()` 模拟时间快进，验证超过 `timeoutMs` 未审批时系统自动返回 `deny` 防挂死；测试 `rejectAll()` 能够将所有挂起任务全量丢弃并清理全部定时器指针。

<!-- checkpoint: npm run test -->
