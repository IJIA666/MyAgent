# 架构设计: 领域服务拆分

我们将在 `src/brain/services/` 目录下建立四个专门的领域服务，它们将被作为依赖注入或实例化于 `SessionManager` 中：

### 1. `ContextRepository.ts`
负责**会话状态的物理生命周期**：
- 抽取 `saveState` 方法（序列化并写入物理磁盘）。
- 抽取 `loadState` 方法（反序列化加载上下文及令牌消耗记录）。
- 抽取 `rollback` 方法（支持指令级别的撤销操作）。

### 2. `CompactionService.ts`
负责**防止 Token 爆仓及上下文提炼**：
- 抽取 `compact` (物理切断机制)。
- 抽取 `triggerAsyncCompactionIfNeeded` (基于水位线的后台提炼拦截)。
- 抽取 `collectReadToolFilePaths` (为 `afterTurn` 做最近访问文件热点驻留)。

### 3. `ToolDispatcher.ts` (或 `ToolOutputFilter.ts`)
负责**工具返回值的安全防御**：
- 抽取 `handleLargeToolOutput` (削减 `readFile` / `grepSearch` 等巨型输出)。
- 抽取 `resolveJitContext` (在工具反馈中按需注入动态 JIT 背景上下文的代码片段)。

### 4. `RuleManager.ts`
负责**系统全局配置与防篡改规则**：
- 抽取 `loadRulesToCache` 与 `reloadRules` (从 `.agent` 等目录下搜集核心规则体系)。

经过上述四大服务的剥离，`SessionManager` (`src/brain/session.ts`) 将减负近 400 行代码，回归为纯正的 **Agent Execution Loop**。
