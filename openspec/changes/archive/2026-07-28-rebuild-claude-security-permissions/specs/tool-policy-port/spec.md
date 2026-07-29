## ADDED Requirements

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

## REMOVED Requirements

### Requirement: 工具安全评估必须通过显式端口

**Reason:** 该墓碑 Requirement 仍引用旧 `ToolPolicyPort`，不再描述活动契约。

**Migration:** 使用 `Tool Authorization Adapter Port`。

### Requirement: Tool Check Permissions Contract

**Reason:** allow/ask/deny/passthrough 结果缺少正式请求与审批动作，导致中央服务继续猜参数。

**Migration:** 使用工具适配器候选与中央最终决策分层。

### Requirement: 策略端口与工具目录必须保持契约隔离

**Reason:** 原 Requirement 针对已删除的 `checkSafety()` 探测问题，未约束适配器与 ToolCatalog 同生命周期。

**Migration:** ToolCatalog 直接注册工具实例及其正式权限适配器。

### Requirement: 安全决策模型必须保持单一来源

**Reason:** 原 Requirement 反而要求继续复用 `SafetyCheckResult(status: pass|suspend|deny)`，与当前 PermissionDecision 冲突。

**Migration:** 最终结果只使用 `PermissionDecision(allow|ask|deny)`。
