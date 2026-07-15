## MODIFIED Requirements

### Requirement: Shell 专用保守命令分析 (Shell-specific conservative command analysis)

系统 MUST 根据已经决议的 Shell family 分派 POSIX、PowerShell 或 CMD 分析器，并返回 `parsed`、`unsupported` 或 `invalid` 状态。POSIX 与 PowerShell 分析器 MUST 在对应能力开关启用时识别条件连接、管道、重定向、后台执行和嵌套命令，并为每个真实可执行节点分别生成证据。语法有效但能力未覆盖、解析器不可用或超过分析上限时 MUST 返回 `unsupported` 并进入 ask/deny，绝不得自动 allow；语法无效输入 MUST 返回 `invalid` 并 deny。

#### Scenario: 原子命令按已决议 Shell 分析

- **WHEN** 一个语法有效的原子命令携带已决议的 `shellKind`
- **THEN** 系统 MUST 只使用该 Shell 的引号、转义和命令规范化规则生成分析结果，不得再次猜测 Shell

#### Scenario: Bash 复合结构被完整提取

- **WHEN** Bash 命令使用已启用的 `;`、`&&`、`||`、`|`、`|&`、`&`、换行、重定向或嵌套结构
- **THEN** POSIX 分析器 MUST 按真实执行关系返回命令节点、连接关系、重定向和嵌套路径，并为每个节点独立产生风险与权限证据

#### Scenario: PowerShell 复合结构使用原生 AST

- **WHEN** PowerShell 命令包含已启用的语句、PipelineChain、管道、重定向、脚本块、子表达式或控制流结构
- **THEN** PowerShell 分析器 MUST 使用原生 AST 提取其中的全部命令和资源，不得使用 Bash 规则或单一字符拆分器代替

#### Scenario: 能力开关关闭时保守询问

- **WHEN** 命令语法有效，但其结构对应的能力开关关闭或解析器暂时不可用，且最低限度扫描未发现 hardline
- **THEN** 系统 MUST 返回 `unsupported` 并使最终权限至多为 ask，不得自动 allow 或伪装为 parsed

#### Scenario: 无效或动态绕过结构保持拒绝

- **WHEN** 命令语法无效，或使用动态求值、编码命令等会隐藏真实执行面的结构
- **THEN** 系统 MUST 返回 `invalid` 或 hardline 风险并 deny，不得通过人工批准绕过不可验证的执行面

#### Scenario: 引号内操作符被视为字面量

- **WHEN** 操作符字符按照当前 Shell 语义位于有效的字面量参数中
- **THEN** 系统 MUST 不得仅因该字符存在就把原子命令误判为复合结构

#### Scenario: 超过分析上限不自动放行

- **WHEN** 复合命令包含超过 50 个可执行节点且未发现 hardline
- **THEN** 系统 MUST 返回 `unsupported` 并进入 ask，绝不得因部分节点看似只读而自动 allow

