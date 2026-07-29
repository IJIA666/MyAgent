## Purpose

定义输入监听、审批生命周期和核心服务的行为测试与覆盖率门禁。该规范优先证明关键状态转换和 fail-closed 分支，并要求覆盖范围对应真实源码，而不是为数字保留已删除模块。

## Requirements

### Requirement: 终端输入监听器具备单元测试覆盖
系统必须（MUST）对 `InputListener` 类的各个生命周期状态流转（启动、挂起、恢复、物理注销、重建）以及 Stdin 事件在挂起状态下的物理拦截阻断逻辑，在不依赖进程全局物理 `process.stdin` 的前提下，提供 100% 自动化的单元测试断言覆盖。

#### Scenario: InputListener 依赖注入 Mock 运行
- **WHEN** 实例化 `InputListener` 并传入自定义的 Mock 可读流与 Mock 可写流，且执行 `start()` 启动
- **THEN** InputListener 能成功在此隔离流上绑定事件监听，利用 Mock 可读流发送数据时可正常触发 `onLineSubmit` 回调，且 Mock 可写流能收到正确的回显，且不会污染全局 process 的 I/O 状态。

#### Scenario: 挂起状态 Stdin 事件物理拦截丢弃与缓冲区防积压
- **WHEN** 全局 `InputListener` 处于挂起（`isPaused = true`）状态，且底层的 Stdin 共享流被外部临时 readline 实例唤醒并被推入大量垃圾字符，且后续系统解挂恢复时
- **THEN** InputListener 的 `'line'` 事件处理器应当在挂起期间阻断并丢弃任何提交；并且在后续调用 `resume()` / `start()` 恢复后，系统必须（MUST）确保内部没有任何在挂起期间积压的垃圾字符涌出，不会发生 any 非预期的 line 提交事件，以确保内部缓冲区状态完全洁净。

#### Scenario: 审批卡关交互时的物理注销与重建（流生命周期所有权物理隔离）
- **WHEN** 触发人机卡关审批或撤销交互，以及在其结束后进行 `start()` 重建时
- **THEN** 界面控制门面必须调用 `close()` 物理注销全局 `readline` 实例并解绑 keypress 监听；在整个 close/start 重建生命周期中，InputListener 决不能（SHALL NOT）关闭或物理销毁传入的 Mock 输入/输出流本身（外部流生命周期释放交由外部测试套件管理），确保重建后的实例能够继续正常在原 Mock 流上读取输入并完成按键仿真，且其回显输出 `isTTY` 物理渲染行为正常。

### Requirement: 审批交互与授权提交机制单元测试覆盖
系统必须（MUST）对 `ApprovalInteractionService` 的挂起、解挂、取消、超时和会话隔离，以及 ToolCallGateway 对可信 ApprovalAction 的原子提交与执行前拒绝提供行为测试覆盖；不得以虚构 Bypass 短路或固定覆盖率数字代替关键分支断言。

#### Scenario: Ask 决策的事件分发与解挂唤醒
- **WHEN** ToolCallGateway 收到最终 ask 并存在已注册审批处理器，随后 UI 用受信 actionId 调用 `resolve()`
- **THEN** 系统必须挂起当前授权 Promise，并在相同会话和请求 id 上恢复，返回对应 ApprovalAction；其他会话或过期 id 不得解挂该请求。

#### Scenario: 取消、超时与提交失败保持执行前拒绝
- **WHEN** 审批被取消、超时、处理器缺失，或 PermissionUpdate 的 CAS/磁盘提交失败
- **THEN** 系统必须返回未执行的权限生命周期错误，不得签发 execution grant，也不得让工具产生实际副作用。

### Requirement: 核心服务覆盖率指标
系统底层核心服务的单元测试覆盖率必须（MUST）满足可执行的安全阈值，以确保关键底座的高可靠性；阈值按真实源码 glob 配置，不以不存在的目录名表达。

#### Scenario: 覆盖率校验与断言
- **WHEN** 执行 `npm run test:coverage` 并收集 V8 coverage 报告
- **THEN** 以下真实范围的 Statement 和 Branch 覆盖率必须（MUST）达到配置的安全下限：
  - `src/core/domain/**/*.ts` — statements ≥ 80%，branches ≥ 70%；
  - `src/core/usecases/security/**/*.ts` — statements ≥ 75%，branches ≥ 65%；
  - 工具运行时的 `ToolCatalog.ts`、`ToolCallGateway.ts`、`ToolExecutor.ts`、`toolRegistry.ts`、`tool-factory.ts`、`effectful-entrypoints.ts` 与 `permissions/*.ts` — statements ≥ 70%，branches ≥ 60%；
  - `src/core/usecases/brain/ContextRepository.ts` — statements ≥ 65%，branches ≥ 55%。

#### Scenario: 覆盖率阈值首次设置流程
- **WHEN** 首次在 `vitest.config.ts` 中启用 coverage thresholds
- **THEN** 必须（MUST）先运行不带阈值的 coverage 报告，核对每个真实范围的当前数值；若低于上述安全下限，先补充能够证明行为的测试，再将确认后的数值写入对应 glob，严禁随意降低安全下限或依赖 `autoUpdate` 自动修改阈值。

#### Scenario: 覆盖率门禁在 CI 中的集成
- **WHEN** CI Ubuntu job 运行 `npm run test:coverage`
- **THEN** 任一范围未达标时 coverage step 必须（MUST）以非零退出码终止，并报告未达标的源码 glob 和指标。
