## MODIFIED Requirements

### Requirement: 文件命名必须可读且唯一

系统 MUST 为 `trace`、`audit`、`session` 文件提供可读且唯一的命名方式，并把三类文件分别放入当前 workspace 对应的 `logs/traces/`、`logs/audits/` 和 `state/sessions/`，便于按项目与会话定位并避免碰撞。

#### Scenario: 同毫秒创建多个会话

- **WHEN** 两个会话在相近时间启动
- **THEN** 两个会话必须生成不同的 `sessionId`，且 `trace`、`audit`、`session` 三类文件必须复用各自会话的同一 `sessionId`

#### Scenario: 文件回溯定位

- **WHEN** 开发者查看当前项目应用数据中的历史文件
- **THEN** 文件名必须保留可读时间前缀和全局唯一部分，并可从分类目录与 session ID 关联到同一会话

### Requirement: 会话快照必须保持恢复语义

系统必须保持 `ContextRepository` 的 JSON 快照语义，不得把会话快照改成追加式 JSONL 日志。快照 MUST 位于当前项目应用数据的 `state/sessions/`，运行时不得回退查找 workspace 内旧 `.myagent/sessions`。

#### Scenario: 保存与恢复

- **WHEN** 系统调用 `saveState()` 保存会话
- **THEN** 生成的 JSON 快照写入当前项目 `state/sessions/`，并仍可被 `loadState()` 直接恢复

#### Scenario: 按会话 ID 定位

- **WHEN** 调用方使用会话 ID 进行恢复
- **THEN** 系统在当前项目 `state/sessions/` 定位符合现行命名契约的文件，调用方无需传入完整文件名

#### Scenario: 部分写入失败

- **WHEN** 快照写入被中断或失败
- **THEN** 系统必须优先保证同目录旧快照仍然可用，并清理本次写入产生的同目录临时文件

#### Scenario: 并发保存

- **WHEN** 多次 `saveState()` 连续或并发触发
- **THEN** 系统必须通过串行执行避免交叉覆盖，不能产生损坏快照文件
