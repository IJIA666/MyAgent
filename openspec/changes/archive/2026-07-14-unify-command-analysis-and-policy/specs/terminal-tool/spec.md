## MODIFIED Requirements

### Requirement: 强制执行原子化操作与反休眠

系统 MUST 通过已决议 Shell family 将受支持的复合终端命令拆成原子子命令，并逐段执行支持性、风险和权限分析。阶段 3 MUST 支持 Bash 顶层 `;`、`&&`、`||` 和 PowerShell 顶层 `;`；任一子命令 deny 时整体 MUST deny，任一子命令 ask 时整体 MUST ask，只有全部子命令 allow 时整体才可 allow。系统不得使用一个跨 Shell 字符正则直接代表完整语义；管道、重定向、后台执行、换行、嵌套、控制流、命令替换、CMD 复合语法或其他未支持结构 MUST 标记为 `unsupported` 或 `invalid` 并拒绝执行。按照当前 Shell 语义处于有效字面量参数内的操作符字符 MUST 被视为普通参数内容。

Plan 模式、其他权限模式和执行期 MUST 消费权限阶段生成的同一份命令分析证据。任何 hardline 或 deny 证据 MUST 在所有模式下保持拒绝，且不得被解析降级、人工询问或 allow 规则覆盖。

#### Scenario: Bash 只读复合命令全部通过

- **WHEN** 模型提交只包含顶层 `;`、`&&`、`||` 的有效 Bash 命令，且所有原子子命令均为 allow
- **THEN** 系统 MUST 保留连接语义并允许整条复合命令进入执行

#### Scenario: PowerShell 复合命令包含写入

- **WHEN** 模型提交使用顶层 `;` 连接的 PowerShell 命令，且其中至少一个原子子命令需要 ask
- **THEN** 系统 MUST 对整条复合命令只发起一次 ask，并展示受影响的子命令证据

#### Scenario: 模型提交未支持的复杂结构

- **WHEN** 模型提交管道、重定向、后台执行、嵌套结构、命令替换或其他阶段 3 未支持结构
- **THEN** Shell 专用分析器 MUST 将命令标记为 `unsupported` 并拒绝执行

#### Scenario: 正常命令参数中包含被当前 Shell 引用的分号

- **WHEN** 模型提交 `git log --grep="feat;fix"` 或语义等价的有效原子命令
- **THEN** 对应 Shell 分析器 MUST 将引号内分号识别为字面量，并允许该原子命令继续进入权限流程

#### Scenario: 不支持结构中的 hardline 操作

- **WHEN** 任一受支持子命令、未支持结构或语法无效输入中包含 Git 写操作或其他不可绕过的 hardline 操作
- **THEN** 最低限度 deny 扫描 MUST 使最终结果保持 `deny`，不得因分析状态降级而转成 `unknown` 或可批准的 `ask`

#### Scenario: Plan 模式和执行期复用同一分析证据

- **WHEN** 系统在 Plan 模式下评估终端命令并在授权后进入执行期
- **THEN** 权限服务和执行器 MUST 复用同一份子命令与聚合证据，执行期不得使用另一套结构规则造成“审批通过但再次解析失败”或副作用漂移
