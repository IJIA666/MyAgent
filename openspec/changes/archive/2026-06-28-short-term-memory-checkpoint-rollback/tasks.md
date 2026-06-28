## 1. 快照管理器基建与生命周期自毁注册 (Scaffold & Lifecycle Setup)

- [x] 1.1 新增快照管理器 `src/core/usecases/security/FileBackupManager.ts`。实现文件物理复制冷备份、新增文件记录、及 `fs.unlinkSync` 物理删除后增文件的操作 API。
- [x] 1.2 在 `FileBackupManager` 中实现基于 `.myagent/backups/` 目录的 `snapshot_manifest.json` 持久化快照配置读写，记录物理备份文件与 `messageHistoryLength` 的映射关系。
- [x] 1.3 重构 `src/core/usecases/engine/LifecycleManager.ts`（或 `session.ts` 的初始化），注册 `FileBackupManager.cleanup()` 回调，在会话正常退出或关闭时物理销毁备份目录，防范磁盘膨胀。

<!-- checkpoint: npx tsc --noEmit -->

## 2. 敏感写操作前置物理备份拦截与会话记录 (Interception & Context Linkage)

- [x] 2.1 重构 `src/core/usecases/engine/agent-loop.ts` 中的 `executeToolTask` 流程。**必须锁定在 `securityCategory === 'write'` 写分类研判之后，且在 `callTool` 物理调用之前**，调用 `FileBackupManager` 触发前置物理快照备份拦截。
- [x] 2.2 在调用 `callTool` 前，利用快照管理器对所涉及的目标路径执行前置 `fs.existsSync` 状态研判：若文件存在，则物理冷备份至 backups 目录并录入该快照点的 `backupFiles` 清单中；若文件不存在，则将该路径直接作为新建文件录入该快照点的 `addedFiles` 清单。
- [x] 2.3 在 `SessionContext` 中保存与该物理快照点对应的内存快照记录（`SnapshotRecord`），将当前的 `messageHistory.length` 长度基准强类型绑定存储至 `snapshot_manifest.json`。

<!-- checkpoint: npx tsc --noEmit -->

## 3. 双轨倒带执行逻辑开发与集成验收 (Rollback Mechanism & Testing)

- [x] 3.1 在 `src/core/usecases/engine/session.ts`（`SessionManager`）或相关控制类中新增 `rollbackToSnapshot(snapshotId: string)` 回滚方法。
- [x] 3.2 实现一致性回退倒带算法：读取备份配置将修改文件写回物理覆盖，调用 `fs.unlinkSync` 将新增文件列表物理拔除，并将内存会话历史 `messageHistory` 强行硬截断（调用 `context.rollbackHistoryToLength`）。
- [x] 3.3 编写物理冷备份快照与双轨倒带倒溯回滚的单元测试，涵盖备份触发、文件覆写与删除、消息指针截断等场景，并执行全量单测验收。

<!-- checkpoint: npm test -->
