## ADDED Requirements

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

## REMOVED Requirements

### Requirement: 目录浏览型只读资源必须显式声明为目录范围资源

**Reason:** 原 Requirement 只描述 listFiles 与旧 SafetyResource，未覆盖正式 PermissionUpdate 和统一会话状态。

**Migration:** 使用 `Additional Directories Are Explicit Permission Actions` 和正式资源证据。

### Requirement: 目录范围读授权必须对子树生效，但不得扩展到兄弟目录或写权限

**Reason:** 子树边界仍需保留，但授权存储必须从旧 session 白名单迁移到 PermissionSessionState。

**Migration:** 使用 `Directory Scope Uses Physical Paths and Exact Operations`。

### Requirement: 目录范围判定必须基于真实物理路径

**Reason:** 该边界被扩展为所有 additional directories 和执行 grant 的统一要求。

**Migration:** 使用 `Directory Scope Uses Physical Paths and Exact Operations`。

### Requirement: 审批提示必须明确告知目录范围

**Reason:** 原 Requirement 没有展示组合 `addDirectories + setMode` 动作。

**Migration:** 新审批 UI 必须显示目录及原子动作集合。

### Requirement: 本 change 仅覆盖 listFiles 的目录浏览语义

**Reason:** 新权限体系需要统一覆盖读、编辑与工具专属破坏性操作，不能继续限制为 listFiles。

**Migration:** 迁移到正式目录动作和操作范围。
