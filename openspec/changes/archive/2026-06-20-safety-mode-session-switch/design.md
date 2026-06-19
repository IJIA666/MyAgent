## 背景

当前系统的安全工作模式（Safe, Auto, YOLO）依赖全局单例（`globalState.workMode`），并通过文件读写工具和终端工具执行频繁的磁盘 `.agent/config.json` 加载，这在多会话并发执行时存在严重的会话状态交叉污染与提权绕过隐患。同时，在 YOLO 模式下缺乏底线命令的安全拦截和密钥泄露的降级审计，用户体验上也缺乏熔断之后的智能自动规划机制。

## 目标与非目标

**目标:**
- **会话级隔离**：多会话（Session）之间的安全模式各自独立，切换互不污染，消除全局越权通道。
- **底线防护**：YOLO 模式下亦享有最高优先级的危险命令硬过滤防线。
- **机密防护**：确保真实机密配置文件 `.env` 等在 YOLO 模式下不会被静默读取或篡改，读取和写入均需人工审批并明示内容。
- **安全与交互闭环**：结合级联安全熔断机制与下游 LLM 结构化反馈，保证挂起队列的资源安全回收，同时实现“中断重构（Halt & Re-plan）”。
- **后台控制**：会话销毁或超时联动中止该会话下在后台运行的所有悬挂终端子进程。

**非目标:**
- 本次重构不引入类似 Docker 容器物理层沙箱的虚拟化隔离。
- 不修改原有的外部命令行交互及 MCP 底层工具调用接口定义。
- 不删除现存的基于命令前缀的普通白名单持久化放行机制。

## 架构决策

### 1. 会话专属安全模式（Session-Scoped Mode & One-way Copy）
- **决策**：将 `workMode` 属性正式定义在 `SessionContext` 类（`src/brain/context.ts`）中。
- **理由**：废除顶层全局静态变量，安全决策从会话上下文直接获取。
- **数据流**：
  1. 系统全局配置模块 `loader.ts` 依然支持热重载，并通过只读 Getter 暴露宿主的默认 `defaultWorkMode`。
  2. 当 `SessionContext` 初始化时，仅单向单次拉取当前全局默认值并深拷贝到实例属性中。
  3. 后续一切对安全模式的读取与修改（如用户通过前端指令临时切换本会话的模式）均只在该会话的 `SessionContext` 内部生效，与磁盘或全局 `process.env` 完全脱离。

### 2. 危险命令最高优先级硬卡关（Hardline Floor）
- **决策**：在 `terminal-guard.ts` 中定义 `HARDLINE_PATTERNS`（如毁灭性递归删除 `rm -rf /`，写原始磁盘 `dd`，以及磁盘格式化 `mkfs`）。
- **理由**：提供最后的底线防护，保障本地系统不被注入恶意指令毁灭。
- **机制**：在 `ExecuteCommandTool.checkSafety` 中，不论当前会话是 YOLO 还是其他模式，首先进行 `HARDLINE_PATTERNS` 匹配。一旦匹配则立刻拦截并返回 `deny`，绕过所有放行判定。

### 3. 级联熔断与大模型中断重塑（Halted Cascade Reject）
- **决策**：在核心审批服务 `ApprovalService.ts` 中关联 `sessionId` 对挂起审批队列进行管理，并提供批量熔断服务方法。
- **理由**：`HumanApprovalPlugin.ts` 插件本身为无状态切面，挂起等待队列由 `ApprovalService.ts`（拥有 `pendingApprovals` 属性）承载。
- **机制**：
  1. 修改 `ApprovalService.ts` 的 `pendingApprovals` 数据结构以存储或感知 `sessionId`，并在其 `wait()` 拦截方法中接收 `sessionId` 参数。
  2. 在 `ApprovalService.ts` 中实现 `rejectBySessionId(sessionId, error)` 批量熔断方法。
  3. 只要当前会话中有任一高危操作被用户显式 `deny` 拒绝，底层通过插件调用 `rejectBySessionId` 自动将该会话中其余处于 pending 的请求状态一并熔断标记为“已中止”，彻底清除残留队列。
  4. 这些被中止的任务将抛出 `HaltedByReject` 异常传递至大模型上下文，大模型捕获后进入“中断重塑（Halt & Re-plan）”流程。

### 4. 机密文件分级隔离与读写审计（Secrets Partition & Audit）
- **决策**：在文件读写和编辑工具的卡关校验中对特定敏感文件执行降级拦截。
- **理由**：彻底隐藏 `.env` 会使 AI 无法协助填充配置或生成占位符，带来极大不便；而 YOLO 模式下直接读写又极易因注入而被静默窃取。
- **机制**：
  1. 区分 `.env.example`（非凭据占位符，允许常态自由读写）与真实包含 Credential 的敏感文件（如 `.env`, `.env.production`）。
  2. 对于真实的敏感配置文件，底层安全机制强行剥夺 YOLO 模式的免密特权。不论何种模式，一旦模型发起读或写操作，强制降级为 `Safe` 模式触发弹窗。
  3. 在弹窗审批界面中，必须明示读取的明文内容或写入的差异 Diff，确保敏感数据外泄对人类用户是可见且处于审计状态下的。

### 5. 生命周期联动与后台进程主动清理（Lifecycle Abort）
- **决策**：扩展终端引擎 `terminal-engine.ts` 中现有的全局后台任务追踪表 `activeTasks`（以 `taskId` 为键），为其携带 `sessionId` 信息。
- **理由**：`terminal-engine.ts` 目前已经存在 `activeTasks: Map<string, TaskInfo>` 全局表管理活跃任务。如果在引擎中再单独新增一个 Map 容易产生内存泄漏与状态不一致。通过复用和扩展它，能最优雅地维护状态的一致性。
- **机制**：
  1. 扩展 `TaskInfo` 接口，增加可选的 `sessionId?: string` 字段。在 `runCommandEngine` 创建后台任务时将当前 `sessionId` 记录进 `activeTasks`。
  2. 在 `terminal-engine.ts` 中暴露出 `abortSessionTasks(sessionId: string)` 强杀接口。
  3. 会话超时回收或被强制关闭时，联动调用 `abortSessionTasks` 遍历 `activeTasks` 表，将所有匹配该会话 ID 且状态为 `running` 的子进程树执行中止（`killProcessTree` 或派发强杀信号），确保后台任务无缝清理。

## 风险与权衡

| 风险点 | 缓解策略 |
| :--- | :--- |
| **测试环境下的 YOLO 自动测试被阻断** | 维护特殊的 mock 环境识别（如 process.env.VITEST 且配置了 mockDecision），在测试流中绕过分级保护卡关以保障集成测试顺利进行。 |
| **多会话并发下的性能开销** | 每一个 Session 独立维护上下文，增加了微量内存占用，但基于 Node.js 内存管理，单个 Class 实例的开销极低。超时回收心跳可以有效控制不活跃会话对内存的长期积压。 |
| **中断重塑对 Token 的额外消耗** | 重新规划可能导致 Token 重新发送，但相较于整个任务由于单步失败而彻底崩塌重来，它的重试代价是局部且受控的。 |
