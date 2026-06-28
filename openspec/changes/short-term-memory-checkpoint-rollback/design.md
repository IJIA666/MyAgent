## 背景

当智能体在连续的代码开发步骤中发生严重编译错误或死循环时，仅仅回溯内存上下文大模型依然无法感知物理文件已经处于被破坏的状态，必须引入一套将物理文件和内存历史同步倒带的冷备份机制，以防范智能体在脏环境下重试造成的死锁。

## 目标与非目标

**目标:**
1. **敏感写操作触发物理备份**：在具有文件脏改副作用的敏感工具（如 EditFileTool、WriteFileTool、ApplyPatchTool，元数据声明为 `securityCategory === 'write'`）物理写入前，自动将目标文件冷备份保存。
2. **多版本冷备份管理**：在 `.myagent/backups/` 目录下以递增版本（`v1`, `v2` 等）或哈希持久化保存目标文件，支持多版本分叉回退。
3. **物理与会话内存双轨倒带（Rollback）**：将备份物理文件写回以覆盖脏文件，物理删除（`unlink`）快照点后产生的增量新建文件，并将内存中的消息历史截断回快照点。
4. **备份生命周期自毁清理**：在 Session 正常关闭时，注册清理回调彻底销毁 `.myagent/backups/` 目录下的所有临时文件，防止污染用户磁盘。

**非目标:**
1. **使用隐藏的 Git 仓库进行 selective checkout**：避免直接对用户项目的隐藏 Git 文件操作，采用性能更高、对 Windows 系统兼容性最强的冷备份物理复制与 unlink 方案。
2. **对网络请求或大模型 API 计费等外部非幂等操作执行回滚**：仅局限于本地工作区文件系统与会话内存的状态回滚。

## 架构决策

### 1. 物理备份与快照索引设计
* **冷备份数据库结构**：
  在 `.myagent/backups/` 目录下为当前 Session 维护一个快照配置文件 `snapshot_manifest.json`，存储每一次快照（`snapshotId`）对应的：
  - `timestamp`: 快照时间戳。
  - `backupFiles`: 包含 `{ originalPath: string, backupPath: string }` 的文件映射列表。
  - `messageHistoryLength`: 该快照点对应的会话内存历史数组长度。
  - `addedFiles`: 自该快照点后，智能体调用创建文件工具新增的文件路径列表（用于回退时定向 `unlink` 物理删除）。

### 2. 快照记录拦截时机 (Record Snapshot)
* **拦截点**：
  在 `agent-loop.ts` 执行工具的 `executeToolTask` 内部，当检索到调用的工具其 `securityCategory` 属于 `write`（具有物理脏改副作用）时：
  1. 在执行工具的真实写入前，判断目标文件是否存在。若存在，读取其原始内容，并在 `.myagent/backups/` 下写入备份文件。
  2. 若目标文件为即将被创建的新增文件，将该路径加入 `addedFiles` 清单中。
  3. 将当前 `messageHistory.length` 作为基准，随同文件备份记录，持久化写入 `snapshot_manifest.json`。

### 3. 一致性回退与倒带算法 (Rollback & Undo)
* **回滚触发机制**：
  当编译检测工具抛出严重错误，或智能体通过控制流触发回退时，调用倒带接口：
  1. **物理文件覆盖**：读取指定快照点对应的 `backupFiles` 清单，将备份文件写回覆盖当前脏文件。
  2. **物理文件拔除**：读取 `addedFiles` 清单，对该快照点之后所新建的文件，调用 `fs.unlinkSync` 进行物理删除。
  3. **内存上下文硬截断**：读取该快照点保存的 `messageHistoryLength`，调用 `SessionContext.truncateHistoryFromIndex(length)`，丢弃该快照点之后产生的所有 tool_call 与 tool_result 消息。

## 风险与权衡

* **[风险点：敏感文件备份频繁导致磁盘空间占用极速膨胀]** -> **[缓解策略]**：
  在 SessionManager 初始化生命周期时注册优雅退出清理回调，通过 `CleanupRegistry` 在会话结束时彻底 `rmSync(..., { recursive: true })` 物理销毁整个 `.myagent/backups/` 目录。
* **[风险点：回退过程中备份文件损坏导致工作区代码永久丢失]** -> **[缓解策略]**：
  回滚执行前，首先对备份文件进行 `existsSync` 校验；如果备份文件损坏，则抛出异常中断回滚，绝不执行对当前脏文件的覆盖或删除操作，确保工作区处于可恢复的安全底线。
