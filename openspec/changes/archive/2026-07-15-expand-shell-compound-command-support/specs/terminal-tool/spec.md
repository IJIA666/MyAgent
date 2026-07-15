## MODIFIED Requirements

### Requirement: 强制执行复合命令逐节点分析与反休眠

系统 MUST 通过已决议 Shell family 对复合终端命令进行结构化分析，并对条件链、管道段、重定向、后台执行和嵌套命令逐节点生成权限证据。任一节点 deny 时整体 MUST deny，任一节点 ask、unknown 或 unsupported 时整体 MUST ask，只有全部节点 allow 时整体才可 allow。系统不得使用一个跨 Shell 字符正则代表完整语义，也不得在授权后使用第二次解析结果拒绝已经批准的同一调用。

Plan 模式、其他权限模式和执行期 MUST 消费权限阶段生成的同一份命令分析证据。任何 hardline 或 deny 证据 MUST 在所有模式下保持拒绝，且不得被解析降级、人工询问或 allow 规则覆盖。后台命令 MUST 进入现有任务托管、取消、超时和进程树清理生命周期。

#### Scenario: Bash 只读复合命令全部通过

- **WHEN** 模型提交由已启用连接符或纯读取管道组成的有效 Bash 命令，且所有命令节点和资源均为 allow
- **THEN** 系统 MUST 保留 Shell 执行语义并允许整条复合命令进入执行

#### Scenario: PowerShell 复合命令包含写入

- **WHEN** 模型提交包含 PowerShell 条件链、管道或重定向，且其中至少一个节点需要 ask
- **THEN** 系统 MUST 对整条复合命令只发起一次 ask，并展示受影响的子命令和资源证据

#### Scenario: 合法但未支持的复杂结构

- **WHEN** 模型提交语法有效但当前能力开关关闭或解析器无法完整覆盖的结构，且未命中 hardline
- **THEN** 工具 MUST 返回 ask；只有当前调用获得明确批准后才可执行，并且不得生成宽泛的持久 allow 规则

#### Scenario: 正常命令参数中包含被当前 Shell 引用的操作符

- **WHEN** 模型提交 `git log --grep="feat;fix"` 或语义等价的有效原子命令
- **THEN** 对应 Shell 分析器 MUST 将引号内操作符识别为字面量，并允许该原子命令继续进入权限流程

#### Scenario: 不支持结构中的 hardline 操作

- **WHEN** 任一已解析节点、未支持结构或语法无效输入中包含 Git 写操作或其他不可绕过的 hardline 操作
- **THEN** 最低限度 deny 扫描 MUST 使最终结果保持 deny，不得因分析状态降级而转成 unknown 或可批准的 ask

#### Scenario: Plan 模式和执行期复用同一分析证据

- **WHEN** 系统在 Plan 模式下评估终端命令并在授权后进入执行期
- **THEN** 权限服务和执行器 MUST 复用同一份节点与聚合证据；unsupported 不得在 Plan 中自动执行，执行期也不得再次解析造成审批后拒绝或副作用漂移

#### Scenario: 重定向目标参与权限决策

- **WHEN** 命令通过输入、输出、追加或错误流重定向访问静态文件目标
- **THEN** 系统 MUST 把目标作为 read/write 资源参与整体权限聚合，动态或无法确定的目标 MUST 至少 ask

#### Scenario: 后台命令进入托管生命周期

- **WHEN** 已启用的后台操作符使命令脱离前台等待
- **THEN** 系统 MUST 为其建立可查询任务、取消信号、超时和进程树清理关系；无法建立关系时 MUST ask/deny，不得自动 allow

#### Scenario: 单批能力可以独立回退

- **WHEN** 管道、条件链、重定向、后台或嵌套中的任一能力开关被关闭
- **THEN** 仅对应结构 MUST 回退为 unsupported/ask，其他已启用结构和统一权限聚合行为 MUST 保持不变

