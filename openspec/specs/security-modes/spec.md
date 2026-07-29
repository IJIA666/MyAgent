## Purpose

定义面向用户的权限模式、规则持久化和会话隔离语义。该规范要求模式切换只影响预期作用域，并让规则来源、危险高级模式和未来默认配置具有明确、可解释的安全边界。
## Requirements
### Requirement: 权限持久化与静态前缀提取 (Always Allow & Static Prefix Abstraction)
当统一权限服务对终端命令产生 `ask` 决策时，系统 MUST 基于解包后的真实子命令生成安全、有限的规则建议。用户选择”始终放行”后，系统 MUST 将对应 `PermissionRule` 原子写入项目 `.myagent/settings.local.json` 的 `permission.allow`，并保留同文件中的其他配置字段。系统不得读取、创建或初始化 `.agent/allowed_commands.json`。

- 系统不得自动生成只包含根命令的宽泛通配规则。
- 系统必须先递归解包解释器外壳，再进行真实子命令匹配与规则建议。
- 安全可泛化时生成有边界的 prefix 规则；不适合泛化时生成 exact 规则，同一批准不得同时生成两个作用域。
- 解包后的真实命令与原始命令不同时，审批提示必须披露真实命令。

#### Scenario: 安全子命令规则的提取与持久化

- **WHEN** 模型发起 `npm run build` 并得到 `ask` 决策，用户选择始终放行建议的 `npm run` 范围
- **THEN** 系统把对应 allow 规则写入项目 `.myagent/settings.local.json`，后续匹配该规则的命令按统一权限优先级评估，而 `npm publish` 不得因该规则自动放行

#### Scenario: 更新权限规则时保留其他设置

- **WHEN** 项目本机 settings 已包含 permission default mode 或 terminal default shell family
- **THEN** 新增 allow 规则后这些字段保持不变，且文件替换要么完整成功要么保留原文件

#### Scenario: 解释器包裹命令下的剥壳匹配

- **WHEN** 已有规则允许真实命令 `npm run test`，模型发起 `powershell -Command “npm run test”`
- **THEN** 系统解包得到真实命令后按相同权限规则评估，不把外壳本身误当作被授权命令

#### Scenario: 审批提示披露真实执行指令

- **WHEN** 未授权的包裹命令与解包后的真实命令不同并产生 `ask`
- **THEN** 审批提示同时展示原始命令和解包后的真实命令，用户据此决定本次允许或持久化规则

#### Scenario: 旧白名单文件存在

- **WHEN** workspace 中存在 `.agent/allowed_commands.json`，但新 settings 中没有对应规则
- **THEN** 系统不得加载或迁移该白名单，也不得自动写入预设 allow 规则

### Requirement: User-Facing Permission Mode Labels

普通权限模式选择器 MUST 只显示 `Manual`、`Accept edits on`、`Plan`。内部 id MAY 保持 `default`、`acceptEdits`、`plan`，但普通帮助、状态、审批成功提示和错误信息 MUST 使用用户可见标签。

#### Scenario: The common picker is opened

- **WHEN** 用户打开普通模式选择器
- **THEN** 系统 MUST 只显示 Manual、Accept edits on 和 Plan
- **THEN** Auto、dontAsk、bypassPermissions 和内部 id MUST NOT 出现在该列表

#### Scenario: A mode transition succeeds

- **WHEN** 会话从 Manual 切换到 Accept edits on
- **THEN** 成功提示 MUST 显示 `Manual → Accept edits on`
- **THEN** 提示 MUST NOT 显示 `default → acceptEdits`

### Requirement: Session Mode and Future Default Are Separate

普通模式切换 MUST 只修改当前 `PermissionSessionState`。未来新会话默认模式 MUST 只能通过显式设置管理动作修改，并持久化到用户选择的可写 settings 来源。

#### Scenario: Workmode changes the current session

- **WHEN** 用户在会话内通过 `/workmode` 选择 Plan
- **THEN** 当前会话 MUST 进入 Plan
- **THEN** `permission.defaultMode` MUST 保持不变

#### Scenario: The user changes the future default

- **WHEN** 用户通过设置或 `/permissions` 明确选择修改未来默认模式及目标来源
- **THEN** 系统 MUST 原子持久化该默认值
- **THEN** 当前会话模式 MUST NOT 被隐式改变

### Requirement: Plan Mode Restores Its Actual Previous Mode

进入 Plan MUST 保存当前 `prePlanMode`；退出 Plan MUST 恢复该模式并清空前态，不得固定回到 Manual。

#### Scenario: Plan entered from Accept edits on

- **WHEN** 当前会话从 Accept edits on 进入 Plan 后退出
- **THEN** 系统 MUST 恢复 Accept edits on

#### Scenario: A restored mode is no longer permitted

- **WHEN** host policy 在 Plan 期间收紧，导致 `prePlanMode` 不再允许
- **THEN** 系统 MUST 回退到 Manual
- **THEN** 系统 MUST 记录可解释的收紧原因
