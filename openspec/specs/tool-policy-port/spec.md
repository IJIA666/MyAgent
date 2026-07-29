## Purpose

定义工具候选安全结果与中央权限决策之间的显式端口边界。该规范让工具只报告候选证据和安全上限，由统一权限服务产生最终结论，避免工具目录或插件拥有第二套决策权。
## Requirements
### Requirement: Tool Authorization Adapter Port

工具策略端口 MUST 暴露受类型约束的 `ToolAuthorizationAdapter`，由工具实现负责解析自身输入并构建 `PermissionRequest` 与审批动作。端口 MUST NOT 返回旧 `SafetyCheckResult`、`SafetyOperation` 或最终用户授权。

#### Scenario: A file adapter builds a request

- **WHEN** `writeFile` 适配器收到包含 `targetPath` 的真实输入
- **THEN** 它 MUST 解析并规范化该字段，生成文件写资源和稳定 Write 权限身份
- **THEN** 中央服务 MUST NOT 再尝试从 `path`、`filePath`、`target` 等候选字段猜测

#### Scenario: A tool rejects invalid input

- **WHEN** 工具适配器无法验证必需参数或资源身份
- **THEN** 它 MUST 返回不可覆盖的输入完整性 deny
- **THEN** 模式、规则和审批 MUST NOT 覆盖该拒绝

### Requirement: Tool Candidate and Central Decision Are Separate

工具适配器 MUST 只产生候选请求、证据和审批动作；managed host cap、规则、模式和最终 `allow/ask/deny` MUST 由单一权限引擎决定。

#### Scenario: A tool proposes an allow

- **WHEN** 工具适配器将调用分类为普通只读
- **THEN** 中央引擎 MUST 继续应用 host cap 与显式规则
- **THEN** 工具自声明 MUST NOT 绕过更严格策略
