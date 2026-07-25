## MODIFIED Requirements

### Requirement: 物理文件与会话内存快照记录 (Physical & Context Session Snapshotting)

系统 MUST 在执行具有物理文件修改副作用的写操作工具前，将目标文件的冷备份快照写入当前项目应用数据的 `tmp/backups/`，并在 `SessionContext` 中保存对应的会话历史索引。备份路径 MUST 来自当前 workspace 的统一路径解析结果，不得写入 workspace `.myagent`。

#### Scenario: 敏感写操作触发物理快照备份

- **WHEN** 智能体即将调用具有 `edit` 或 `write` 副作用的工具修改 `src/index.ts`
- **THEN** 系统在物理写入前把原文件备份到当前项目 `tmp/backups/`，以递增版本或哈希追踪，并在内存中保存当前消息历史长度对应的快照点

### Requirement: 敏感编译失败触发双轨一致性回滚 (Coordinated State Rollback)

当智能体因严重编译错误、死循环或规划卡死发出回退动作时，系统 MUST 从当前项目应用数据的 `tmp/backups/` 恢复物理文件、删除该快照点之后创建的增量文件，并将内存消息历史截断到快照记录。恢复和清理 MUST 限定在已验证的当前项目备份及 workspace 目标范围内。

#### Scenario: 智能体卡死触发双轨倒带

- **WHEN** 智能体触发回退命令并指定有效快照点
- **THEN** 系统读取当前项目 `tmp/backups/` 中对应备份恢复 `src/index.ts`，删除该快照点后的增量新文件，并将 `messageHistory` 截断至记录长度

#### Scenario: 备份路径不属于当前项目

- **WHEN** 回滚记录指向当前项目备份目录之外的路径或无法通过规范化边界校验
- **THEN** 系统拒绝物理恢复与删除操作，保留当前文件并返回受治理的回滚错误
