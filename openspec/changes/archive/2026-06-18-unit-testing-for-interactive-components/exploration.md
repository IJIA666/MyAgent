# 探索主题: 交互式与审批组件的单元测试方案探索

## 1. 问题定义
本次安全加固引入了 `InputListener` 的物理注销与重建、Stdin 输入的 `isPaused` 物理丢弃拦截，以及 `ApprovalService` 的同步非阻塞事件分发机制。为了避免这部分终端 REPL 的输入解析和人机审批流程在后续系统重构中发生功能退化（Regression），需要探索并沉淀出一套能对该终端交互层代码进行安全、稳定、自动化验证的单元测试方案。

## 2. 关键发现与调研结果
- **代码库现状**：
  - 目前 `test/` 目录下包含 42 个用例，均成功通过，主要覆盖了 `context`、`models`、`plugins` 和 `terminal` 执行引擎。
  - 核心输入控制器 `InputListener` 和 `CliFacade` 的单元测试覆盖率目前为 0%。其核心痛点在于 `InputListener` 在实例化 readline 接口时，硬编码了 `process.stdin` 和 `process.stdout` 全局流，且直接在底层注册了 `keypress` 监听器，在不具备交互式终端的环境中极其难以测试。
- **核实与洞察**：
  - 联网调研结果显示，直接通过 `vi.mock('readline')` 全量模拟 Node.js 的 readline 模块十分脆弱，由于 readline 内部状态复杂，极易导致 `TypeError: rl.close is not a function` 等运行期错误。
  - 最为推荐且在 Jest/Vitest 环境中最为稳定的方案是**“流的依赖注入（Dependency Injection）”**。即将原本硬编码的输入输出流改为从构造函数传入（生产环境传入 `process.stdin` / `process.stdout`，而测试环境传入一个自定义的 Mock 可读流与可写流）。

## 3. 方案对比与推荐方向
| 评估维度 | 方案 A (依赖注入流 Mock) | 方案 B (基于 `mock-stdin` 全局劫持) | 结论 |
| :--- | :--- | :--- | :--- |
| 代码侵入性 | 较高 (需重构 `InputListener` 的流获取逻辑) | 低 (无需修改现有业务代码) | 方案 B 占优 |
| 测试稳定性 | 极高 (独立流物理隔离，无全局状态污染) | 中 (若未及时 cleanup 容易污染其他单测) | 方案 A 占优 |
| 维护成本 | 低 (接口清晰，完全符合 SOLID 设计原则) | 高 (强依赖第三方辅助包，增加依赖链路) | 方案 A 占优 |
| 覆盖范围 | 全面 (可以模拟完整的 readline 生命周期事件) | 有限 (仅可单向模拟 Stdin 键入) | 方案 A 占优 |

**推荐路径**：采用 **方案 A (依赖注入流 Mock)**。
通过对 `InputListener` 及其底层的 readline 实例化进行输入输出流的依赖注入改造。这能够完美解决 `process.stdin` 单例污染和事件挂起测试困难的痛点。更为重要的是，它在后续我们规划进行的“统一输入资源调度中心 (Input Dispatcher)”的重构中，能够直接升级为对 Dispatcher 输入拦截进行闭环单元测试的坚实护栏。

## 4. 约束、风险与未知项及实战防御建议

- **测试悬挂隐患与物理销毁防御**：
  - *风险*：如果测试用例未能在超时前向 Mock 流中推送结束符 `null`，将导致 Vitest 进程由于事件循环中存在活跃的可读流而挂起不退。
  - *实战防御*：在使用 `PassThrough` 等 Mock 流进行测试时，务必在 `afterEach` 钩子中执行防御性销毁：
    ```typescript
    afterEach(() => {
      listener.close();      // 调用已有的物理销毁逻辑
      mockStdin.destroy();   // 强制摧毁 mock 输入流
      mockStdout.destroy();  // 强制摧毁 mock 输出流
    });
    ```
    只要确保流被 `.destroy()`，Node.js 的事件循环就一定能清空退出，彻底杜绝悬挂隐患。

- **第三方库硬编码劫持与边界职责解耦**：
  - *风险*：`InputListener` 中可能调用的外部组件（如 `@clack/prompts` 等）可能硬编码了 `process.stdin`，依赖注入可能无法在测试环境下彻底拦截其对控制台的抢占。
  - *实战防御*：坚持“职责解耦”的单元测试思想。对于第三方交互库，不试图将其行为纳入 `InputListener` 的核心单测中（第三方库属于外部边界系统）。单元测试只需通过 Mock 行为来验证**“当触发外部交互拉起时，InputListener 确实正确触发了 close/pause 交出控制权，并在结束后执行了 start/resume 收回控制权”**即可。这种控制权让渡行为的断言，彻底避免了对第三方弹窗内部复杂状态的集成测漏。

## 5. 否决方案
- **方案 C（全量 mock 劫持 readline 模块）**：
  由于 `readline.Interface` 的内部私有方法过多，强行将其全部 Stub mock 掉（如 `prompt`, `setPrompt`, `pause`, `resume`, `close` 等）不仅开发成本高且脆弱，而且完全无法验证“物理注销与重建期间的 stdin 事件分发与丢弃”的真实功能，属于无实际验证效力的“为测而测”，故予以否决。
