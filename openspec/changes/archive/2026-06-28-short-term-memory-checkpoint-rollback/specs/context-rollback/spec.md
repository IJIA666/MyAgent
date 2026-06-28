## ADDED Requirements

### Requirement: 物理文件与会话内存快照记录 (Physical & Context Session Snapshotting)
系统必须(MUST)在触发具有物理文件修改副作用的写操作工具（其元数据声明 `securityCategory === 'write'`）执行前，自动对目标文件在 `.myagent/backups/` 目录下创建冷备份快照，并且系统必须(MUST)在 `SessionContext` 中保存对应的会话历史索引，确立物理文件与内存会话双轨绑定的快照点。

#### Scenario: 敏感写操作触发物理快照备份
- **WHEN** 智能体即将调用具有 `edit` / `write` 副作用的工具 `editFile` 且参数 `targetPath` 指向 `src/index.ts`。
- **THEN** 系统在实际执行该工具的物理写入前，自动将 `src/index.ts` 文件的原始内容冷备份存盘至 `.myagent/backups/` 目录下，并以递增版本或哈希进行版本追踪；同时在内存 `SessionContext` 中生成快照点记录（Snapshot Record），保存当前的 `messageHistory` 消息长度基准。

### Requirement: 敏感编译失败触发双轨一致性回滚 (Coordinated State Rollback)
当智能体在连续开发步骤中出现编译严重报错、死循环或规划卡死，向引擎发出回退动作时，系统必须(MUST)执行双轨一致性倒带回滚：将备份物理文件写回以覆盖脏文件，利用 `unlink` 彻底删除该快照点后产生的增量新建文件，并且将内存中的 `messageHistory` 指针截断回上一个快照点对应的长度基准。

#### Scenario: 智能体卡死触发双轨倒带
- **WHEN** 智能体触发回退命令并指向指定快照点。
- **THEN** 系统立即读取 `.myagent/backups/` 中该快照点的备份文件覆盖并恢复 `src/index.ts` 的原始内容；彻底 `unlink` 物理删除自该快照点后所有新建的文件；并将 `SessionContext.messageHistory` 强行截断至快照记录保存的数组长度，使智能体及工作区环境同步回滚到之前的安全状态。
