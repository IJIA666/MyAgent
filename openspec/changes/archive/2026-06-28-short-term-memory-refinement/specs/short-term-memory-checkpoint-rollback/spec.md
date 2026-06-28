## 新增需求

### 需求: 协同安全类别的物理文件冷备份 (Precise Side-Effect Checkpointing)
系统必须(MUST)在工具安全卡关（checkSafety）中对有物理文件写副作用的操作（如 `edit`、`write` 级别的 `securityCategory`）进行拦截。在物理执行该写操作前，自动调用备份机制将目标物理文件当前状态备份到本地沙箱隐藏目录（如 `.myagent/backups/`）。每次交互 Turn 结束时必须(MUST)将本次变更的文件索引记录为具有唯一消息 ID 索引的物理 Snapshot 快照点。

#### 场景: 执行敏感写操作前拦截冷备份
- **WHEN** 智能体决定执行有写副作用的 `edit_file` 工具。
- **THEN** 系统在实际修改该文件前拦截其路径，复制其未改动状态作为冷备份存盘；在本次执行 Turn 完毕后，自动基于 mtime 检测并生成版本递增的物理快照快照点，且该快照与本轮消息 ID 绑定。

### 需求: 物理与内存一致性一键回退 (Transaction rollback and Checkout)
当需要对短期记忆进行 Undo/Rollback 回档时，系统必须(MUST)提供一键式 `fileHistoryRewind` 物理回退能力。系统必须(MUST)同时对 `messageHistory` 内存历史数组和物理文件系统同步回退到目标快照状态：如果文件在快照点时不存在则物理 `unlink` 删除它；若不一致则使用 `copyFile` 物理覆盖还原。

#### 场景: 对智能体错误修改执行快照物理还原
- **WHEN** 智能体做出了错误的修改导致代码编译卡死，触发回滚至之前某个消息 ID 快照的需求。
- **THEN** 系统清除该消息 ID 之后的全部内存对话历史；同时遍历文件快照，将此后新建的文件物理删除（unlink），将发生改动的文件从冷备份物理复制写回（copyFile）还原其原始状态与权限。
