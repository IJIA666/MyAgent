## 背景

在先前的安全沙箱加固开发中，我们重构了绝对路径物理去模糊解析、 sensitive 命令正则审查，并为了解决 Stdin 共享污染与回显污染（输入 `1` 显示 `11`），在 `facade.ts` 和 `InputListener` 的提问节点重构实现了“物理注销与重建”。
由于 `InputListener` 在其内部硬编码引用了 Node.js 进程的全局 `process.stdin` 和 `process.stdout` 物理流单例，导致在非交互式命令行测试环境中极难对键盘输入、物理销毁、重建逻辑进行仿真拦截与断言。这块终端 REPL 交互的核心主干代码目前单元测试覆盖率为 0%，容易在后续大范围的底座架构重构中引入功能退化。

## 目标与非目标

**目标:**
1. **输入/输出流的依赖注入（Dependency Injection）**：重构 `InputListener`，使其能够支持外部传入可选的自定义 `input` 与 `output` 流，解耦对进程全局流的硬强依赖。
2. **闭环物理销毁防御**：在测试用例中增加对 mock 流与 listeners 的销毁机制，并在 `afterEach` 钩子中执行 Mock 流的物理 `.destroy()` 以及 `listener.close()`。通过彻底排空 Node.js 的事件循环队列，杜绝测试执行时的事件悬挂（Vitest 挂起）。
3. **边界职责解耦测试**：贯彻“职责解耦”的单元测试思想。对于提问和二次确认，只在单元测试中 Mock 其边界行为，断言 `InputListener` 是否在触发时执行了 `close()` / `pause()` 以交出 Stdin 控制权，并在解挂后执行了 `start()` / `resume()`，不集成运行和深度测试第三方交互库（如 `@clack/prompts`）的内部繁冗状态。
4. **自动化用例全面覆盖**：在 `test/` 目录下创建专门的单元测试用例，全量覆盖 InputListener 的 start、pause、resume、close 状态转换以及 keypress 拦截阻断等边界。
5. **ApprovalService 核心测试**：全量测试 [ApprovalService.ts](file:///d:/Projects/MyAgent/src/brain/services/ApprovalService.ts)。包括 Bypass 短路拦截模式验证（不触发任何回调和挂起定时器）与基于同步事件回调（`onNeedApprovalHandler`）的 Promise 挂起及 `resolve` 唤醒机制。

**非目标:**
1. **引入第三方物理劫持库**：本设计不引入 `mock-stdin` 等对全局进程 `stdin` 执行物理劫持的三方依赖，保持测试完全在 Node.js 原生的流隔离与依赖注入中运行，实现零全局状态污染。
2. **深度集成测试第三方库行为**：不把第三方交互弹窗（如 `@clack/prompts`）纳入核心 InputListener 的单测中，拒绝“为测而测”的外部边界深度行为测试。
3. **超前重构底座**：本 Change 纯粹用于流重构与补齐测试护栏，不在本 Change 中超纲执行“统一输入资源调度中心 (Input Dispatcher)”的大范围重构。

## 架构决策

1. **改造 InputListener 以支持 I/O 流注入**：
   重构 `InputListenerOptions`，在实例化时增加两个可选的属性：
   ```typescript
   export interface InputListenerOptions {
     getIsGenerating: () => boolean;
     getModelName: () => string;
     onAbort: () => void;
     onRollback: () => void;
     onLineSubmit: (line: string) => void;
     /** 注入的可选自定义输入流 */
     input?: NodeJS.ReadableStream;
     /** 注入的可选自定义输出流 */
     output?: NodeJS.WritableStream;
   }
   ```
   并在 `InputListener` 内部实例化 `readline.Interface` 时应用该注入流：
   ```typescript
     this.rl = createInterface({
       input: this.inputStream || process.stdin,
       output: this.outputStream || process.stdout,
       completer: completer,
       history: this.commandHistory
     });
   ```
   *理由*：这解耦了底层全局的物理流单例，使得在测试环境中，每个用例可以直接传入通过 `new stream.PassThrough()` 新建的、彼此物理隔离的 Mock 流，大大提升了测试用例的纯粹性与并发运行安全性。

2. **单元测试执行期的物理销毁防御**：
   在测试文件 `input-listener.test.ts` 中设立防御性释放策略：
   ```typescript
   afterEach(() => {
     if (listener) {
       listener.close();
     }
     if (mockStdin) {
       mockStdin.destroy();
     }
     if (mockStdout) {
       mockStdout.destroy();
     }
   });
   ```
   *理由*：当 Node.js 的事件循环中存在未物理销毁的活跃 I/O 流（哪怕只是 Mock 内存流），Vitest 测试进程便会因为活跃句柄未清空而悬挂挂起。显式的 `.destroy()` 可以让 V8 引擎和 Libuv 事件循环立即排空，保证测试完成即退。

3. **isTTY 属性物理劫持仿真**：
   在单元测试中，实例化的 Mock 流对象需要强制在其上写入 `isTTY = true` 属性：
   ```typescript
   const mockStdin = new PassThrough();
   (mockStdin as any).isTTY = true;
   ```
   *理由*：Node.js 内部的 `readline` 模块在创建接口时，高度依赖输入流的 `isTTY` 属性来启用高级终端字符响应（如 Prompt 回显、ANSI 控制序列）。若不显式劫持为 `true`，`readline` 将会退化为基础批处理读写流模式，造成测试环境与真实的生产 TTY 终端环境发生严重行为偏差。

4. **外部注入流的生命周期所有权隔离**：
   We 明确规定：`InputListener.close()` 仅负责物理销毁其内部维护的 `readline.Interface` 实例并注销 `keypress` 监听器，决不能去物理关闭或销毁外部注入的自定义可读/可写 Mock 流。流生命周期的释放所有权完全交由外部测试套件（如 `afterEach` 的 `destroy()`）进行管理。
   *理由*：这避免了在测试重建流程时（如 `close()` 之后再次 `start()`），由于底层的 Mock 流被 `InputListener` 随手物理废弃，导致重建后的 readline 接口无法再从原本的 Mock 流上读取数据的“流报废”陷阱。

5. **ApprovalService 逻辑单测隔离与挂起唤醒状态仿真**：
   由于 `ApprovalService` 属于纯业务逻辑类且管理着异步审批的状态。测试中我们无需任何复杂的物理 I/O 流模拟。我们在测试中传入 Spy/Mock 的回调处理器对 `registerApprovalHandler` 进行断言。分别测试：
   - 正常模式：在 `wait()` 时挂起 Promise 并同步调用已注册的回调，并在后续通过外部调用 `resolve()` 将 Promise 正确唤醒并传回用户的决定，自动清除可能存在的超时定时器；
   - Bypass 模式：在 `isBypassMode = true` 时直接短路返回 `{ action: 'once' }`，且断言不会触发任何回调和内部挂起机制。
   *理由*：这以极低的改动与执行成本，提供了对全局审批服务最强有力的质量防护。

## 风险与权衡

1. **[风险点：第三方库可能偷偷对 `process.stdin` 执行 `resume()` 破坏拦截]**
   - *缓解策略*：职责解耦。既然我们已经在卡关时物理调用了 `listener.close()`，此时全局实例绑定的 listeners 已全部清空解绑，即使三方库让底层流 `resume()`，也不会触发全局实例的任何事件，安全防线坚如磐石。
2. **[风险点：CI 环境下盲等时延导致偶发性断言失败（Flaky Tests）]**
   - *缓解策略*：**废弃**任何微任务 `nextTick` 或毫秒定时器等盲目延迟等待手段。在测试中完全采用**事件驱动模型**，利用 Promise 捕获 `onLineSubmit` 的回调触发事件以唤醒测试断言进程，消除时间竞态，保证测试在并发和负载波动下 100% 具备确定性。
3. **[风险点：挂起期间垃圾数据积压在 Readline 输入缓冲区，在解挂后突然涌出引发 line 事件]**
   - *缓解策略*：在挂起拦截用例中，不仅要在挂起期间写入大量测试输入以断言事件已被物理拦截，还必须在后续调用 `resume()` / `start()` 恢复后，额外进行一次数据空白断言，证明没有任何积压的残留数据在解挂后被突然消费，以此确保内部缓冲区状态的物理洁净。
