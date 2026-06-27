# 探索主题: 低危缺陷（技术债务）设计与分析 (L-1 ~ L-5)

## 1. 问题定义

在完成高危和中危缺陷治理后，对项目历史遗留的 5 处低危技术债务进行全量排查和解耦重构：
1. **L-1：`AgentLoop` 领域层核心直接 exec Shell 命令**。
2. **L-2：`MemoryRefinementToolRegistry` 将写操作工具假标记为 `'read'`**。
3. **L-3：`SecurityService` 全局单例的临时白名单跨会话污染隐患**。
4. **L-4：`checkCacheAndCalibrate` 缓存失效诊断函数为死代码**。
5. **L-5：`generateSummaryAsync` 中 `localAbortController` 无效占位**。

---

## 2. 关键发现与调研结果

- **代码库现状**：
  - `agent-loop.ts` 中 `runPostRunCheck` 强依赖 `child_process` 中的 `exec` 函数对物理项目执行 Lint 和编译校验，使得核心推理循环与系统底层强耦合。
  - `MemoryService.ts` 中 `writeMemoryFile` 被假标记为 `'read'` 避开安全审批，误导了锁管理器获取读锁而导致潜在的写并发冲突。
  - `SecurityService.ts` 的内存缓存临时读写白名单使用共享 `Set`，致使多会话并发时 Session A 的临时越权授权在 Session B 中被共享越权。
  - `checkCacheAndCalibrate` 定义于 `agent-loop.ts` 内但从未被消费，导致缓存击穿诊断能力完全失效。
  - `OpenAiLlmAdapter.ts` 内部冗余创建了未被 abort 触发的局部 `AbortController`。

---

## 3. 方案对比与推荐方向

### L-1 & L-4: 诊断核心保留与 exec 解耦

- **职能分配与时序关系**：
  - `checkCacheAndCalibrate`（L-4 缓存击穿诊断）仅依赖并维护 `AgentLoop` 自身的实例状态（如 `lastCacheReadTokens`、`pendingChanges`），它代表了纯粹的**领域层状态机自我诊断**，必须作为私有方法留在领域类 `AgentLoop` 内。
  - `runPostRunCheck`（L-1 静态测试校验）是不依赖任何推理状态的**物理底层 shell 操作**，理应剥离核心领域，解耦为 Driven Port 端口契约。
  - **修改顺序**：在修改 `agent-loop.ts` 时，必须**先**执行 L-4（复活击穿诊断逻辑，将原有 `updateLastApiUsage` 替换为流式消费 `checkCacheAndCalibrate` 生成器事件），**后**执行 L-1（将 `this.runPostRunCheck()` 替换为对新注入的 `this.qualityCheckPort.runPostRunCheck()` 的调用）。

### L-3: 临时白名单隔离与职责拆分

- **端口只读性保护 (Interface Purity)**：
  - `SessionEventPort` 作为“只读策略输出端口”，应拒绝引入任何 `add` 或 `clear` 等写操作方法，以捍卫端口的职责纯洁度。其只读 API `hasTemporaryReadWhitelist` 和 `hasTemporaryWriteWhitelist` 保持不变。
- **白名单写入与生命周期职责归属**：
  - **写入机制**：在 `SessionContext` （`context.ts`，它作为领域类具体实现 `SessionEventPort`）中新增 `addTemporaryReadWhitelist(pathStr)`、`addTemporaryWriteWhitelist(pathStr)` 以及 `clearTemporaryWhitelists()` 公开写方法，它们内部通过隐式传入 `this.sessionId` 将写操作打包投递给 `SecurityService`：
    ```typescript
    public addTemporaryReadWhitelist(pathStr: string): void {
      SecurityService.getInstance().addTemporaryReadWhitelist(this.sessionId, pathStr);
    }
    ```
  - **调用机制**：`HumanApprovalPlugin` 拦截确权通过后，改用其持有的 `sessionContext` 调用：
    `sessionContext.addTemporaryReadWhitelist(safetyResult.targetPath);`
    这使得 Plugin 无需获取 `sessionId` 即可安全写盘。
  - **生命周期终点销毁 (Lifecycle Hook)**：在 `agent-loop.ts` 推理循环最外层的 `finally` 块中（即配置的落盘写盘后），调用 `this.context.clearTemporaryWhitelists()` 物理清理属于当前会话的临时白名单。这彻底规避了内存泄露及授权残留。

---

## 4. 详细设计 (Detailed Design)

### 4.1 L-1：QualityCheckPort 解耦
1. **[NEW]** [QualityCheckPort.ts](file:///d:/projects/MyAgent/src/ports/driven/QualityCheckPort.ts)
   ```typescript
   export interface QualityCheckPort {
     runPostRunCheck(): Promise<{ success: boolean; output: string }>;
   }
   ```
2. **[NEW]** [ShellQualityCheckAdapter.ts](file:///d:/projects/MyAgent/src/adapters/tools/ShellQualityCheckAdapter.ts)
   - 实现该端口，调用 `child_process` 执行 `npm run lint` 和 `npx tsc --noEmit`。
3. **[MODIFY]** [agent-loop.ts](file:///d:/projects/MyAgent/src/core/usecases/agent-loop.ts)
   - 移除原有的私有方法 `runPostRunCheck`。
   - 构造函数新增依赖接收：`private qualityCheckPort: QualityCheckPort`。

### 4.2 L-2 读写假标记修正
- 修改 `MemoryService.ts` 中 `writeMemoryFile` 工具的安全标记返回为 `'write'`，消除欺骗注释。

### 4.3 L-3 临时白名单隔离
1. **[MODIFY]** [SecurityService.ts](file:///d:/projects/MyAgent/src/core/usecases/SecurityService.ts)
   - 将 `temporaryReadWhitelist` 和 `temporaryWriteWhitelist` 更改为 `Map<string, Set<string>>`。
   - 更新 `addTemporaryReadWhitelist`、`addTemporaryWriteWhitelist`、`hasTemporaryReadWhitelist`、`hasTemporaryWriteWhitelist` 和 `clearTemporaryWhitelists` 方法签名，加入首位参数 `sessionId: string`，并做对应的 Map 分拆读写。
2. **[MODIFY]** [context.ts](file:///d:/projects/MyAgent/src/core/domain/context.ts)
   - 新增 `addTemporaryReadWhitelist`、`addTemporaryWriteWhitelist` 以及 `clearTemporaryWhitelists`。为这三个修改上下文状态的写方法强制引入与主干一致的 busy 锁防护（若 `this.isProcessing` 处于 true 状态则抛出 Error 阻断），保障执行态状态修改的并发安全性；方法内部隐式绑定 `this.sessionId` 并转发给 `SecurityService`。
   - 改造已有的 `has...` 方法传入 `this.sessionId`。
3. **[MODIFY]** [HumanApprovalPlugin.ts](file:///d:/projects/MyAgent/src/core/usecases/HumanApprovalPlugin.ts)
   - 拦截确权通过后，改用 `sessionContext.addTemporaryReadWhitelist` 写入。
4. **[MODIFY]** [agent-loop.ts](file:///d:/projects/MyAgent/src/core/usecases/agent-loop.ts)
   - 在 `finally` 块中加入：
     ```typescript
     this.context.clearTemporaryWhitelists();
     ```

### 4.4 L-4 击穿诊断死代码复活
- 在 `agent-loop.ts` 中大模型 `complete` 结算处：
  ```typescript
  if (event.usage) {
    const diagGen = this.checkCacheAndCalibrate(event.usage as ApiUsage);
    for (const diagEvent of diagGen) {
      yield diagEvent;
    }
  }
  ```

### 4.5 L-5 异步摘要生成超时控制优化
- 在 `OpenAiLlmAdapter.ts` 中，使用 `AbortSignal.timeout(summaryTimeoutMs)` 代替无效的 `AbortController` 占位。

---

## 5. 约束与未知项
- 接口变动后，需同步适配 `test/brain/SecurityService.test.ts` 中有关临时白名单的测试断言。
