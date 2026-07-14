## 新增需求

### 需求: Shell 专用保守命令分析 (Shell-specific conservative command analysis)

系统 MUST 根据已经决议的 Shell family 分派 POSIX、PowerShell 或 CMD 分析器，并返回 `parsed`、`unsupported` 或 `invalid` 状态。阶段 3 MUST 将 Bash 顶层 `;`、`&&`、`||` 和 PowerShell 顶层 `;` 拆分为有序原子子命令；这些子命令全部可分析时 MUST 返回 `parsed`。管道、重定向、后台执行、换行、嵌套、控制流、CMD 复合语法及其他未覆盖结构 MUST 返回 `unsupported`，且不得执行。

#### 场景: 原子命令按已决议 Shell 分析

- **WHEN** 一个语法有效的原子命令携带已决议的 `shellKind`
- **THEN** 系统 MUST 只使用该 Shell 的引号、转义和命令规范化规则生成分析结果，不得再次猜测 Shell

#### 场景: 受支持的复合结构按 Shell 拆分

- **WHEN** Bash 命令使用顶层 `;`、`&&`、`||`，或 PowerShell 命令使用顶层 `;` 连接可分析的原子命令
- **THEN** 对应分析器 MUST 按原顺序返回子命令及连接关系，且每个子命令 MUST 独立产生风险和权限证据

#### 场景: 未支持的复杂结构保持不可执行

- **WHEN** 命令包含当前阶段不支持的顶层管道、连接符、重定向、脚本块或嵌套命令
- **THEN** 系统 MUST 返回 `unsupported` 并拒绝执行，不得因命令部分看似只读而自动允许

#### 场景: 引号内操作符被视为字面量

- **WHEN** 操作符字符按照当前 Shell 语义位于有效的字面量参数中
- **THEN** 系统 MUST 不得仅因该字符存在就把原子命令误判为复合结构

### 需求: Deny 证据具有不可逆优先级 (Deny evidence has irreversible precedence)

系统 MUST 在解析支持性判断和权限模式处理之前执行不可绕过的 deny/hardline 检查。解析失败、能力降级、显式 ask、allow 规则以及任何 PermissionMode MUST NOT 覆盖已经识别出的 deny/hardline 证据。

#### 场景: 未支持输入中的 hardline 保持拒绝

- **WHEN** 命令结构为 `unsupported` 或 `invalid`，同时最低限度安全扫描识别出 hardline 操作
- **THEN** 最终工具检查和权限决策 MUST 保持 `deny`，不得降级为 `unknown` 或 `ask`

#### 场景: 显式 ask 不跳过工具 deny

- **WHEN** 调用同时命中显式 ask 规则和工具 hardline deny
- **THEN** 系统 MUST 完成工具检查并按 `deny > ask > allow` 聚合为 `deny`

### 需求: 命令分析证据贯穿执行被复用 (Command analysis evidence is reused through execution)

同一次终端工具调用 MUST 只生成一次命令分析证据，并将其贯穿工具权限检查、最终权限决策、授权执行上下文和执行 effect。复合命令 MUST 按 `deny > ask > allow` 聚合子命令结果，且后续阶段 MUST NOT 使用另一套正则或静态工具类别重新解释该调用的副作用。

#### 场景: 复合决策保留已分析 effect

- **WHEN** 一个受支持的复合命令通过逐子命令权限流程并开始执行
- **THEN** 整体权限 MUST 由所有子命令按 `deny > ask > allow` 聚合，执行结果的 effect MUST 来源于授权上下文中的同一份聚合证据
