# permission-management Specification

## Purpose
TBD - created by archiving change rebuild-claude-security-permissions. Update Purpose after archive.
## Requirements
### Requirement: Permissions Command Shows Effective State and Sources

系统 MUST 提供 `/permissions` 管理入口，显示当前用户标签、内部模式诊断值、未来默认模式、有效 deny/ask/allow 规则、来源文件、managed cap、额外目录和最近一次决策链。

#### Scenario: The user inspects permissions

- **WHEN** 用户运行 `/permissions`
- **THEN** 系统 MUST 使用 Manual、Accept edits on、Plan 等用户标签显示当前状态
- **THEN** 每条规则 MUST 显示来源与是否被更高层策略压制
- **THEN** 凭据、完整命令秘密和敏感参数 MUST NOT 被回显

### Requirement: Permissions Command Performs Constrained Updates

`/permissions` MUST 支持删除或替换用户可编辑规则、移除 session 额外目录和显式设置未来默认模式。managed/host policy MUST 始终只读。

#### Scenario: The user removes a session directory

- **WHEN** 用户选择移除一个 session additional directory
- **THEN** 系统 MUST 原子应用 `removeDirectories`
- **THEN** `stateVersion` MUST 递增，旧执行 grant MUST 失效

#### Scenario: The user attempts to edit managed policy

- **WHEN** 用户从 `/permissions` 尝试修改 managed rule
- **THEN** 系统 MUST 拒绝并说明来源只读

### Requirement: Recent Permission Decisions Are Explainable

系统 MUST 保留有界、去敏的最近决策记录，至少包含 runtime tool、权限身份、规则匹配链、host cap、mode、资源摘要、最终结果和审批动作。

#### Scenario: The user investigates a denied call

- **WHEN** 用户查看最近一次 deny
- **THEN** `/permissions` MUST 显示产生 deny 的最高优先级原因及被压制的低层候选
- **THEN** 系统 MUST NOT 仅显示一段无法定位来源的自然语言

