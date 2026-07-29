# protected-resource-policy Specification

## Purpose
TBD - created by archiving change rebuild-claude-security-permissions. Update Purpose after archive.
## Requirements
### Requirement: Layered Host Policy Uses Stricter Wins

系统 MUST 按 managed host、trusted user host、project/local、session、tool candidate 的层次合成策略。低层 MUST 只能维持或收紧高层结果，不得放宽 managed/user host cap。

#### Scenario: A project allow conflicts with managed deny

- **WHEN** 项目或 session allow 命中一个被 managed policy 拒绝的调用
- **THEN** 最终结果 MUST 为 `deny`
- **THEN** `/permissions` MUST 显示该 allow 被哪个高层策略压制

#### Scenario: A lower layer adds an ask

- **WHEN** 高层允许某调用，但项目或工具候选要求询问
- **THEN** 最终结果 MUST 为 `ask`

### Requirement: Protected File Resources Precede Modes and Memory

系统 MUST 在普通模式、bypass 和 memory 特例之前识别受保护文件资源，至少覆盖 `.git`、`.myagent/settings*.json`、`.myagent/rules`、hooks、启动配置、IDE 自动执行配置、`.env` 与凭据文件。

#### Scenario: Accept edits targets a protected path

- **WHEN** 当前模式为 Accept edits on，编辑目标位于受保护路径
- **THEN** 系统 MUST 按 protected policy 返回 ask 或 deny
- **THEN** Edit 分类 MUST NOT 自动放行

#### Scenario: A memory path escapes into settings

- **WHEN** memory 工具路径通过 symlink、junction 或路径穿越解析到 settings、instructions 或 memory 根外
- **THEN** memory allow MUST NOT 生效
- **THEN** 系统 MUST 拒绝该访问

### Requirement: Protected Network and External Side Effects

host policy MUST 覆盖 cloud metadata、loopback 管理接口、link-local、私网 SSRF 范围，以及发送、发布、删除、付款和权限变更等外部账号副作用。

#### Scenario: A tool accesses cloud metadata

- **WHEN** Browser、Terminal、MCP 或插件尝试访问 cloud metadata endpoint
- **THEN** managed host floor MUST 拒绝或要求不可绕过的显式授权
- **THEN** MCP 的 openWorld/readOnly 自声明 MUST NOT 降低限制

#### Scenario: An external action is irreversible

- **WHEN** 工具准备发送、发布、付款、删除远端数据或修改权限
- **THEN** 证据 MUST 标记准确副作用与目标账号
- **THEN** 普通 Edit 模式 MUST NOT 自动放行

### Requirement: Caller and Child-Agent Trust Cannot Expand Authority

每次授权请求 MUST 携带宿主验证的 caller identity、channel trust 和 audience。子 Agent MUST 继承父级最终有效策略和工具面；未验证外部 caller MUST NOT 复用本地用户授权。

#### Scenario: A remote caller reuses a local session id

- **WHEN** 未验证的远程请求携带一个有效本地 session id
- **THEN** 系统 MUST NOT 继承该会话的用户授权
- **THEN** 请求 MUST 按未验证 caller 的严格策略处理

#### Scenario: A child requests a broader tool set

- **WHEN** 子 Agent 配置声明比父 Agent 更宽的工具或目录范围
- **THEN** 有效范围 MUST 取父级与子级请求的交集

