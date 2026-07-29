## ADDED Requirements

### Requirement: Authorized Roots Distinguish Workspace Memory and Additional Directories

执行期路径解析 MUST 分别维护物理 workspace 根、精确默认/custom memory 根和 session additional directories，并按操作类型验证。任何父目录或字符串相似前缀 MUST NOT 因子根授权而可达。

#### Scenario: Default memory is initialized

- **WHEN** 应用初始化当前项目 memory 根
- **THEN** 路径边界 MUST 只允许其精确物理子树
- **THEN** `.myagent` 父目录和其他项目数据 MUST 保持范围外

#### Scenario: A non-existing child is resolved

- **WHEN** 目标尚不存在
- **THEN** 系统 MUST realpath 最接近的已存在祖先并安全拼回剩余部分
- **THEN** symlink/junction MUST NOT 逃逸授权根

### Requirement: Execution Revalidates Approved Physical Resources

执行器 MUST 将计划中的物理资源身份与执行前解析结果比较。路径、symlink、junction、挂载或大小写身份发生变化时，原 grant MUST 失效。

#### Scenario: A symlink is swapped after approval

- **WHEN** 文件批准后 symlink 被替换为指向范围外目标
- **THEN** 执行期复核 MUST 拒绝

### Requirement: Legacy Temporary Whitelists and Call Claims Are Removed

`secureResolveReadPath`/`secureResolveWritePath` MUST 只消费当前 execution plan、正式 additional directories 和静态授权根。生产路径 MUST NOT 查询 temporary read/write whitelist、claimed resource 或 CallCapability。

#### Scenario: A legacy whitelist entry exists in restored state

- **WHEN** 旧会话数据包含 temporary whitelist 或 claimed resource
- **THEN** 新路径解析 MUST 忽略该状态
- **THEN** 访问 MUST 根据当前 PermissionSessionState 重新授权

## REMOVED Requirements

### Requirement: 动态路径越界 Ask 授权与生命周期隔离

**Reason:** 原 Requirement 使用 session 白名单和 call capability 作为执行期授权来源。

**Migration:** 使用 additionalDirectories、不可变 ExecutionPlan 和单次 ExecutionGrant。
