# Technical Design: fix-low-defects

本设计详述针对 L-1 至 L-5 技术债务的详细技术重构。

## 1. 详细设计 (Detailed Design)

### 1.1 L-1：QualityCheckPort 物理自测解耦
1. **[NEW]** [QualityCheckPort.ts](file:///d:/projects/MyAgent/src/ports/driven/QualityCheckPort.ts)
   ```typescript
   export interface QualityCheckPort {
     runPostRunCheck(): Promise<{ success: boolean; output: string }>;
   }
   ```
2. **[NEW]** [ShellQualityCheckAdapter.ts](file:///d:/projects/MyAgent/src/adapters/tools/ShellQualityCheckAdapter.ts)
   - 引用 `util.promisify` 和 `child_process.exec`。
   - 实现 `runPostRunCheck()` 方法，包揽 `npm run lint` 与 `npx tsc --noEmit`。
3. **[MODIFY]** [agent-loop.ts](file:///d:/projects/MyAgent/src/core/usecases/agent-loop.ts)
   - 移除原 `runPostRunCheck` 私有实现。
   - 构造函数签名更新，注入 `qualityCheckPort: QualityCheckPort`。
   - 调用点更新为：`const checkResult = await this.qualityCheckPort.runPostRunCheck();`。
4. **[MODIFY]** [SessionManager.ts](file:///d:/projects/MyAgent/src/core/usecases/SessionManager.ts)
   - 构造接收并保存 `qualityCheckPort`；在 `createSession` 生成 `AgentLoop` 时将其透传给构造。
5. **[MODIFY]** [index.ts](file:///d:/projects/MyAgent/src/index.ts)
   - 实例化 `ShellQualityCheckAdapter` 并注入给 `SessionManager`。

### 1.2 L-2：MemoryRefinementToolRegistry 标记修正
1. **[MODIFY]** [MemoryService.ts](file:///d:/projects/MyAgent/src/core/usecases/MemoryService.ts)
   - 将 `getTool` 返回值更正为：
     ```typescript
     public getTool(name: string): ToolMetadata | undefined {
       if (name === 'writeMemoryFile') {
         return { securityCategory: 'write', name: 'writeMemoryFile' };
       }
       return undefined;
     }
     ```

### 1.3 L-3：SecurityService 临时白名单隔离
1. **[MODIFY]** [SecurityService.ts](file:///d:/projects/MyAgent/src/core/usecases/SecurityService.ts)
   - 更改 `temporaryReadWhitelist` 和 `temporaryWriteWhitelist` 为 `Map<string, Set<string>>`。
   - 所有白名单读写清理方法均加入 `sessionId: string` 首位参数，在 Map 中进行对应 Set 的隔离存取。
2. **[MODIFY]** [context.ts](file:///d:/projects/MyAgent/src/core/domain/context.ts)
   - 新增方法 `addTemporaryReadWhitelist(pathStr)`、`addTemporaryWriteWhitelist(pathStr)` 和 `clearTemporaryWhitelists()`，加上 `if (this.isProcessing) throw ...` busy 锁保护，并透传其本身的 `this.sessionId` 交由单例处理。
   - 改造已有只读方法 `has...`，传入 `this.sessionId`。
3. **[MODIFY]** [HumanApprovalPlugin.ts](file:///d:/projects/MyAgent/src/core/usecases/HumanApprovalPlugin.ts)
   - 将原 `securityService.addTemporaryReadWhitelist` 和 `addTemporaryWriteWhitelist` 调用变更为 `sessionContext.addTemporaryReadWhitelist` 与 `sessionContext.addTemporaryWriteWhitelist`。
4. **[MODIFY]** [agent-loop.ts](file:///d:/projects/MyAgent/src/core/usecases/agent-loop.ts)
   - 在 `finally` 块的落盘操作后，物理执行当前会话白名单的彻底销毁：
     ```typescript
     this.context.clearTemporaryWhitelists();
     ```

### 1.4 L-4：缓存自诊断死代码复活
1. **[MODIFY]** [agent-loop.ts](file:///d:/projects/MyAgent/src/core/usecases/agent-loop.ts)
   - **修改顺序**：在修改 `agent-loop.ts` 时，必须**先**执行 L-4（复活击穿诊断逻辑），**后**执行 L-1（修改 runPostRunCheck 的 Port 调用）。
   - 在接收到模型 `complete` 结算 `event.usage` 时，替换原 `updateLastApiUsage` 为流式消费 `checkCacheAndCalibrate`（注：由于 `checkCacheAndCalibrate` 方法体内最末行已经封装并执行了 `updateLastApiUsage` 更新会话上下文，外层完全替换即可，严禁在外部重复调用以免发生用量冗余累加）：
     ```typescript
     if (event.usage) {
       const diagGen = this.checkCacheAndCalibrate(event.usage as ApiUsage);
       for (const diagEvent of diagGen) {
         yield diagEvent;
       }
     }
     ```

### 1.5 L-5：Abort 占位控制优化
1. **[MODIFY]** [OpenAiLlmAdapter.ts](file:///d:/projects/MyAgent/src/adapters/llm/OpenAiLlmAdapter.ts)
   - 移除冗余的 `localAbortController`，在 `generateSummaryAsync` 中直接调用大模型接口并透传 `AbortSignal.timeout(summaryTimeoutMs)` 进行物理超时解绑。

---

## 2. 自动化测试对齐 (Test Alignment)
1. **[MODIFY]** `test/brain/SecurityService.test.ts`
   - 将对临时白名单测试断言的调用签名加入 `sessionId: 'test-session'` 前置参数。
