## ADDED Requirements

### Requirement: Terminal Authorization Uses Shell-Specific Adapters

`execute_command` MUST 根据显式或已解析 shell family 使用 Bash 或 PowerShell 权限适配器，复用现有复合命令分析并产生逐节点资源、规则建议和 side effect。中央权限服务 MUST NOT 重新解析整条命令字符串。

#### Scenario: A PowerShell compound command is requested

- **WHEN** `execute_command` 使用 PowerShell 执行复合命令
- **THEN** PowerShell 适配器 MUST 解析每个子命令、连接符和 wrapper
- **THEN** 规则和审批 MUST 只覆盖已展示的确定范围

### Requirement: Arbitrary Code Uses a Minimal Credential Profile

Terminal、脚本解释器、代码执行、MCP 子进程、插件和子 Agent MUST 由统一执行层构造显式最小环境。模型 provider key、浏览器认证材料、MCP secrets 和其他宿主凭据 MUST 默认不继承。

#### Scenario: A shell prints its environment

- **WHEN** Terminal 或任意代码枚举环境变量
- **THEN** 未授权宿主 secrets MUST 不存在
- **THEN** 仅当前执行 profile 明确列出的变量 MAY 暴露

#### Scenario: A tool requires a credential

- **WHEN** 某外部工具确实需要特定凭据
- **THEN** credential profile MUST 精确绑定该工具、caller 和执行计划
- **THEN** 其他工具 MUST NOT 继承

### Requirement: Terminal Approval Discloses Actual Containment

高风险命令或任意代码审批 MUST 显示当前 sandbox status 和宿主级风险。没有可验证 OS containment 时 MUST 使用 `policy-only` 或等价文案，不得声称命令已被沙箱隔离。

#### Scenario: Native Windows has no containment backend

- **WHEN** 原生 Windows Terminal 调用进入审批，且没有有效 containment backend
- **THEN** UI MUST 明确显示文件、网络、进程和凭据只受应用层策略限制

### Requirement: Terminal Cannot Bypass Protected Resource Policy

Shell 分析、allow rule、Accept edits on 和 bypassPermissions MUST NOT 覆盖 cloud metadata、凭据、受保护路径、SSRF floor 或 managed command deny。

#### Scenario: An allowed wrapper reaches a protected target

- **WHEN** 已允许的解释器 wrapper 包裹一个访问 protected resource 的子命令
- **THEN** 逐节点分析和 host policy MUST 拒绝或要求不可绕过审批
- **THEN** wrapper allow MUST NOT 自动放行内部命令
