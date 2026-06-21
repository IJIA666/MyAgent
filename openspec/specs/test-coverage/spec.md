## 新增需求

### 需求: 终端输入监听器具备单元测试覆盖
系统必须（MUST）对 `InputListener` 类的各个生命周期状态流转（启动、挂起、恢复、物理注销、重建）以及 Stdin 事件在挂起状态下的物理拦截阻断逻辑，在不依赖进程全局物理 `process.stdin` 的前提下，提供 100% 自动化的单元测试断言覆盖。

#### 场景: InputListener 依赖注入 Mock 运行
- **WHEN** 实例化 `InputListener` 并传入自定义的 Mock 可读流与 Mock 可写流，且执行 `start()` 启动
- **THEN** InputListener 能成功在此隔离流上绑定事件监听，利用 Mock 可读流发送数据时可正常触发 `onLineSubmit` 回调，且 Mock 可写流能收到正确的回显，且不会污染全局 process 的 I/O 状态。

#### 场景: 挂起状态 Stdin 事件物理拦截丢弃与缓冲区防积压
- **WHEN** 全局 `InputListener` 处于挂起（`isPaused = true`）状态，且底层的 Stdin 共享流被外部临时 readline 实例唤醒并被推入大量垃圾字符，且后续系统解挂恢复时
- **THEN** InputListener 的 `'line'` 事件处理器应当在挂起期间阻断并丢弃任何提交；并且在后续调用 `resume()` / `start()` 恢复后，系统必须（MUST）确保内部没有任何在挂起期间积压的垃圾字符涌出，不会发生 any 非预期的 line 提交事件，以确保内部缓冲区状态完全洁净。

#### 场景: 审批卡关交互时的物理注销与重建（流生命周期所有权物理隔离）
- **WHEN** 触发人机卡关审批或撤销交互，以及在其结束后进行 `start()` 重建时
- **THEN** 界面控制门面必须调用 `close()` 物理注销全局 `readline` 实例并解绑 keypress 监听；在整个 close/start 重建生命周期中，InputListener 决不能（SHALL NOT）关闭或物理销毁传入的 Mock 输入/输出流本身（外部流生命周期释放交由外部测试套件管理），确保重建后的实例能够继续正常在原 Mock 流上读取输入并完成按键仿真，且其回显输出 `isTTY` 物理渲染行为正常。

### 需求: 审批挂起机制单元测试覆盖
系统必须（MUST）对 `ApprovalService` 的挂起、解挂以及 Bypass 机制提供 100% 自动化的逻辑单元测试覆盖。

#### 场景: Bypass 模式下的逻辑短路
- **WHEN** 审批服务处于 `isBypassMode = true` 状态且被调用 `wait()` 时
- **THEN** 系统必须立即短路返回放行决策，且不能触发任何人机提问回调或内部超时器。

#### 场景: 正常模式下的事件分发与解挂唤醒
- **WHEN** 调用 `wait()` 且有已注册的回调处理器，随后外部调用 `resolve()` 传入决策动作为 `once`/`always`/`deny` 时
- **THEN** 系统必须同步派发包含工具元数据的新闻事件，挂起当前 Promise，并能在 `resolve` 调用后成功解挂唤醒，返回一致的用户决策。

### 需求: 核心服务覆盖率指标
系统底层核心服务的单元测试覆盖率必须 (MUST) 满足预设的安全阈值，以确保核心底座的高可靠性。

#### 场景: 覆盖率校验与断言
- **WHEN** 执行单元测试并收集覆盖率报告。
- **THEN** 系统整体及 core/usecases 内部各服务（CompactionService, ContextRepository, ToolDispatcher, SecurityService, RuleManager）的 Statement 覆盖率均应当达到或超过设定的基线。
