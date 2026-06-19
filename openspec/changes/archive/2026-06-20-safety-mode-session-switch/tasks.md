## 1. 配置与会话上下文基建重构

- [x] 1.1 修改 `src/config/types.ts` 中的 `WorkMode` 类型，添加 `'Plan'` 模式。并在全局 `AppConfig` 接口中确保其包含此安全模式定义。
- [x] 1.2 重构 `src/config/loader.ts` 中的 `loadConfig()` 及热重载模块，仅使用 Getter 暴露只读的全局 `defaultWorkMode`，废除任何在加载阶段对全局进程级 `workMode` 的硬回写，并导出支持 `'Plan'` 的安全模式默认加载器。
- [x] 1.3 在 `src/brain/context.ts` 的 `SessionContext` 类中引入私有属性 `workMode: WorkMode`，增加 Getter 和 Setter 方法，并在初始化构造函数中将全局只读的默认安全模式拷贝作为副本持有。
- [x] 1.4 修改 `src/action/virtual-mcp.ts` 的 `NativeTool` 接口中的 `checkSafety` 和 `execute`，确保 `sessionContext?: unknown` 类型被正确重构为强类型的 `SessionContext`。

<!-- checkpoint: npm run build -->

## 2. 终端引擎与命令安全审查重构

- [x] 2.1 在 `src/action/tools/system/terminal-config.ts` 中增加对 `Plan` 模式的类型支持，重构 `getWorkMode` 与 `loadWorkMode`，确保其不再对外直接读写全局静态变量，仅用于提取系统层面的初始配置，并确保静态前缀提取的向后兼容。
- [x] 2.2 在 `src/action/tools/system/terminal-guard.ts` 中定义绝对拦截正则表达式集 `HARDLINE_PATTERNS`，并在导出中暴露拦截校验器。
- [x] 2.3 重构 `src/action/tools/system/terminal.ts` 的 `ExecuteCommandTool.checkSafety`：优先通过传入的 `sessionContext` 获取会话专属的 `workMode`；并在判断任何工作模式前调用 `HARDLINE_PATTERNS` 校验，命中时立即拦截并直接返回 `deny`。在 `Plan` 模式下直接拒绝任何具有副作用的写入指令。

<!-- checkpoint: npm run test -->

## 3. 人机审批服务与级联安全熔断

- [x] 3.1 修改 `src/brain/services/ApprovalService.ts`，在其 `pendingApprovals` 数据结构中增加 `sessionId` 存储（或使 `wait()` 挂起拦截方法支持接收 `sessionId` 参数）。
- [x] 3.2 在 `ApprovalService.ts` 中实现 `rejectBySessionId(sessionId, error)` 批量熔断方法。并在 `HumanApprovalPlugin.ts` 捕获拦截到拒绝信号时，调用此方法清空当前会话在 `pendingApprovals` 中的其余所有挂起请求，并向各被熔断调用链路抛出 `HaltedByReject` 结构化异常以配合大模型“中断重塑”上下文。

<!-- checkpoint: npm run test -->

## 4. 超时心跳回收与后台子进程联动清理

- [x] 4.1 扩展 `src/action/tools/system/terminal-engine.ts` 中的 `TaskInfo` 接口，增加可选的 `sessionId?: string` 字段。并在 `runCommandEngine` 执行创建后台任务时，将当前 `sessionId` 记录进 `activeTasks` 任务实体中。
- [x] 4.2 在 `terminal-engine.ts` 中暴露 `abortSessionTasks(sessionId: string)` 强杀清理接口，使其遍历 `activeTasks` 列表中所有状态为 `running` 且匹配当前 `sessionId` 的任务并执行强杀。在会话因为超时回收或主动注销时，联动调用该接口实现后台进程的安全清退。

<!-- checkpoint: npm run build -->

## 5. 机密文件分级保护

- [x] 5.1 修改 `src/action/tools/file/` 中的文件操作工具（`ReadFileTool`, `WriteFileTool`, `EditFileTool`）的 `checkSafety` 卡关判定。
- [x] 5.2 放行 `.env.example` 文件的自由访问；对于真实的敏感配置文件（`.env`, `.env.*`），强制降级为 `Safe` 模式审批，即使在 YOLO 模式下也弹窗让用户审核明文及 Diff。

<!-- checkpoint: npm run test -->

## 6. 代码质检返工任务

- [x] 6.1 修复 `src/action/tools/filesystem/file-system.ts` 中的 `loadWorkMode` 导入但未使用的 ESLint 报错。
- [x] 6.2 修复 `src/action/tools/filesystem/file-system.ts` 中的 `ReadFileTool.checkSafety` 的 `sessionContext` 未使用的 ESLint 报错（重命名为 `_sessionContext`）。
