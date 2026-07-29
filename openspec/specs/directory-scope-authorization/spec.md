## Purpose

定义目录范围授权的资源表达、物理路径边界和可复用范围。该规范要求目录授权按真实子树和具体操作生效，并阻止相似前缀、兄弟目录、链接逃逸或写操作继承只读能力。
## Requirements
### Requirement: Additional Directories Are Explicit Permission Actions

额外目录 MUST 由 `addDirectories`/`removeDirectories` PermissionUpdate 显式管理，并保存在当前 `PermissionSessionState`。一次性授权、普通规则或工具返回的自然语言 MUST NOT 隐式增加目录。

#### Scenario: The user explicitly enables editing in an external directory

- **WHEN** 用户选择“本会话在该目录开启 Accept edits on”
- **THEN** 系统 MUST 原子应用规范化目录的 `addDirectories` 和 `setMode(acceptEdits, session)`
- **THEN** UI MUST 显示该目录及其子树将获得的范围

#### Scenario: Allow once does not add a directory

- **WHEN** 范围外文件调用获得 Allow once
- **THEN** 当前调用结束后 additional directories MUST 保持不变

### Requirement: Directory Scope Uses Physical Paths and Exact Operations

额外目录和目录范围授权 MUST 基于 `getPhysicalRealPath()` 后的物理目录身份判断子树关系，且 MUST 分离 read、ordinary Edit 与 destructive 操作。

#### Scenario: A symlink exits an additional directory

- **WHEN** additional directory 内的 symlink 或 junction 指向范围外物理路径
- **THEN** 目标 MUST NOT 命中该目录授权

#### Scenario: A sibling prefix looks similar

- **WHEN** 已增加 `C:\Projects\a`，调用访问 `C:\Projects\a2`
- **THEN** 系统 MUST 视为范围外

#### Scenario: Edit scope is used for delete

- **WHEN** 目录只获得普通 Edit 范围，模型请求删除或批量移动其内容
- **THEN** 系统 MUST 重新按 destructive 工具策略评估

### Requirement: Directory Updates Invalidate Old Grants

增加或移除额外目录 MUST 递增 `stateVersion`。基于旧目录快照签发但尚未消费的执行 grant MUST 失效。

#### Scenario: A directory is removed before execution

- **WHEN** 文件调用获批后、执行前，用户移除对应 additional directory
- **THEN** 原 grant MUST 被拒绝
- **THEN** 调用 MUST 重新进入权限决策
