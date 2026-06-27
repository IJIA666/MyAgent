# Technical Design: fix-medium-defects

本设计详述针对 M-1 与 M-2 缺陷的具体技术实现和接口定义。

## 1. 详细设计 (Detailed Design)

### 1.1 M-1：CompactionService 与 SessionContext 的重构
1. **[MODIFY]** [context.ts](file:///d:/projects/MyAgent/src/core/domain/context.ts)
   - **新增 API**：
     ```typescript
     /**
      * 基于指定起始索引进行物理截断。
      * 丢弃中间的消息数组，保留 system prompt (index 0) 以及从指定索引开始的后续所有消息。
      * 
      * @param startIndex - 保留历史消息的起始索引点
      */
     public truncateHistoryFromIndex(startIndex: number): void {
       if (this.isProcessing) {
         throw new Error('Cannot modify SessionContext: session is currently busy processing hooks.');
       }
       if (startIndex <= 1 || startIndex >= this.messageHistory.length) return;
       const systemMsg = this.messageHistory[0];
       const keptMsgs = this.messageHistory.slice(startIndex);
       this.messageHistory = [systemMsg, ...keptMsgs];
     }
     ```

2. **[MODIFY]** [CompactionService.ts](file:///d:/projects/MyAgent/src/core/usecases/CompactionService.ts)
   - 重构 `compact()` 实现：
     ```typescript
     public async compact(): Promise<boolean> {
       try {
         const fullHistory = this.context.getHistory();
         
         // 1. 统计 user 角色消息的总数（扫描限制在 index 1 及之后）
         let userCount = 0;
         let cutoffIndex = -1;
         for (let i = fullHistory.length - 1; i >= 1; i--) {
           if (fullHistory[i].role === 'user') {
             userCount++;
             if (userCount === this.compactionRetainCount) {
               cutoffIndex = i;
               break;
             }
           }
         }

         // 2. 前置守卫：如果 user 消息总数不足 compactionRetainCount，不予截断
         if (cutoffIndex === -1) {
           return false;
         }

         // 3. 调用新 API 执行基于索引的物理截断
         this.context.truncateHistoryFromIndex(cutoffIndex);

         // 4. 如果兜底也没有摘要，则塞一个默认兜底
         if (!this.context.getCheckpointSummary()) {
           const fallback = buildStaticFallbackSummary(undefined, undefined);
           this.context.setCheckpointSummary(fallback);
         }

         await this.contextRepo.saveState();
         return true;
       } catch (e) {
         logger.warn(`[CompactionService] 上下文硬截断失败: ${e}`);
         return false;
       }
     }
     ```

### 1.2 M-2：ContextRepository 的异常观测
1. **[MODIFY]** [ContextRepository.ts](file:///d:/projects/MyAgent/src/core/usecases/ContextRepository.ts)
   - 在头部导入 `logger`：
     ```typescript
     import { logger } from '../../utils/logger.js';
     ```
   - 在 `saveState()` 的 `catch` 块中补齐日志捕获：
     ```typescript
     try {
       // ... 写盘逻辑 ...
     } catch (e) {
       // 捕获并吞掉异常，静默落盘失败不应阻断核心流程，但需记录警告日志保持可观测性
       logger.warn(`[ContextRepository] 写入会话状态文件失败: ${e}`);
     }
     ```

---

## 2. 自动化测试对齐 (Test Alignment)
1. **[MODIFY]** `test/brain/CompactionService.test.ts`
   - 由于物理截断机制基于 user 消息计数，单元测试需要同步更新：
     - Mock 或构造包含足够数量（至少 4 个 `user` 角色消息）的消息流，以触发硬截断流程。
     - 对齐新的 API 断言逻辑。
