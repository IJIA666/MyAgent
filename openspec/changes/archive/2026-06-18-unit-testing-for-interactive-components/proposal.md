## 改造原因

在早期的安全沙箱加固开发中，系统引入了终端写倾向命令拦截、路径绝对路径物理校验以及物理注销与重建 `InputListener` 的卡关机制。然而，由于 `InputListener` 与 `CliFacade` 等终端输入流控制模块硬编码引用了全局 `process.stdin` 和 `process.stdout` 单例流，其单元测试覆盖率目前为 0%。
为了防范后续在底层交互调度层大范围重构时出现功能退化（Regression）或回归 Bug，本变更旨在通过对 `InputListener` 执行依赖注入（Dependency Injection）改造，解耦对全局物理 Stdin 的强依赖，并利用 Mock 可读/可写流在 Vitest 测试套件中全面补齐交互层的单元测试覆盖，为底座代码建立坚固的自动化单测护栏。

## 变更内容

1. **依赖注入改造**：重构 `InputListener` 的构造器与实例化逻辑，支持可选传入自定义的 `input` (NodeJS.ReadableStream) 和 `output` (NodeJS.WritableStream) 流。生产环境默认回退至 `process.stdin` 与 `process.stdout`，而测试环境则由外部注入隔离的 Mock 流。
2. **物理销毁测试**：在测试用例中验证物理注销（`close()`）与重建（`start()`）的逻辑。在 `afterEach` 中执行 Mock 输入输出流的物理 `.destroy()` 释放，杜绝由于流未关闭导致的测试悬挂（Vitest 挂起）。
3. **职责解耦测试**：不试图对第三方提问库（如 `@clack/prompts`）进行集成深度测试。通过 Mock 边界行为，只测试 `InputListener` 在外部卡关和交互发生时，是否正确执行了 `close`/`pause` 出让控制权以及重建等让渡行为。
4. **单元测试用例补齐**：在 `test/` 目录下创建专门的测试文件，全量覆盖输入监听器各种生命周期下的按键监听、回显阻断与历史记录留存逻辑。
5. **ApprovalService 单元测试**：针对审批服务核心逻辑 [ApprovalService.ts](file:///d:/Projects/MyAgent/src/brain/services/ApprovalService.ts) 补齐单元测试，覆盖 Bypass 模式下的逻辑短路、人机挂起回调分发以及 Promise 的挂起与唤醒机制。

## 业务能力

### 新增业务能力
- test-coverage: 交互式与审批组件的单元测试覆盖规范，保障 REPL 控制器生命周期状态流转的物理隔离与无悬挂运行安全。

### 修改业务能力
- 无

## 影响范围

- **受影响代码**：[input-listener.ts](file:///d:/Projects/MyAgent/src/interface/io/input-listener.ts)（改造构造函数参数与流引用）、[facade.ts](file:///d:/Projects/MyAgent/src/interface/facade.ts)（调整实例化传参）。
- **新增测试**：在 `test/` 目录下新建 `test/interface/input-listener.test.ts` 与 `test/brain/ApprovalService.test.ts` 测试套件。
