## ADDED Requirements

### Requirement: Permission Configuration Has Trusted Sources

权限配置 MUST 区分 managed、user、project、local、CLI 和 session 来源，并按 host cap 合成。`permission.defaultMode` MUST 只接受当前可交付模式；项目/local 配置 MUST NOT 启用 `bypassPermissions` 或其他受信高级能力。

#### Scenario: An old Auto default is loaded

- **WHEN** settings 或环境变量包含 `permission.defaultMode: auto`
- **THEN** 加载器 MUST 记录不含敏感原值的迁移告警
- **THEN** 系统 MUST 回退到 `default`
- **THEN** Auto 运行时 MUST NOT 被构造

#### Scenario: Project settings request bypass

- **WHEN** project 或 local settings 将未来默认模式设置为 `bypassPermissions`
- **THEN** 系统 MUST 忽略该值并使用更严格默认

### Requirement: Permission Settings Updates Are Atomic and Compare-And-Swap

规则、未来默认模式和可持久目录更新 MUST 通过 `SettingsRepository` 的版本或摘要 CAS、临时文件写入和原子替换完成。磁盘成功之前 MUST NOT 更新会话内存。

#### Scenario: Two writers update permissions

- **WHEN** 两个并发更新基于同一旧版本写权限设置
- **THEN** 最多一个更新 MUST 成功
- **THEN** 另一个 MUST 返回冲突并保持原文件完整

#### Scenario: Atomic replace fails

- **WHEN** 临时文件写入或替换失败
- **THEN** 原 settings MUST 保持可读且字段不丢失
- **THEN** 对应工具副作用 MUST NOT 开始

### Requirement: Legacy Permission Configuration Is Not Dual-Matched

加载器 MUST 拒绝或忽略旧 WorkMode、ApprovalPolicy、白名单、PascalCase 运行时工具规则和 Auto classifier 配置，不得为兼容而同时维护新旧权限身份。

#### Scenario: A legacy PascalCase rule exists

- **WHEN** settings 包含无法映射到正式工具适配器的旧规则
- **THEN** 系统 MUST 记录可操作的迁移告警并忽略该规则
- **THEN** 系统 MUST NOT 通过宽松字符串别名继续匹配

#### Scenario: Unrelated settings coexist

- **WHEN** 权限设置更新与 terminal、model 或其他字段位于同一文件
- **THEN** 原子更新 MUST 保留所有未修改字段
