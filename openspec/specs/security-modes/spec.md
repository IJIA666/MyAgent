## 新增需求

### 需求: 权限持久化与静态前缀提取 (Always Allow & Static Prefix Abstraction)
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

### 需求: 动态安全工作模式 (Work Modes)

> ❌ 已删除 — 由 Claude PermissionMode 同构实现替代。旧 `Safe`、`Auto`、`YOLO`、`Plan` 枚举同时承载阶段和审批语义，已在 `claude-permission-model` 变更中移除。

**Migration:** 迁移到 `PermissionMode`（`default`、`acceptEdits`、`plan`、`auto`、`dontAsk`、`bypassPermissions`）与统一权限服务。

### 需求: Session-Scoped Permission Modes

每个会话 MUST 独立保存 `PermissionMode`，模式切换 MUST 通过统一模式管理器执行，不得使用进程级共享模式状态。

#### 场景: One session mode does not affect another session

- **WHEN** 会话 A 切换到 `bypassPermissions`，会话 B 保持 `default`
- **THEN** 会话 B 的工具调用 MUST 继续按 `default` 评估

#### 场景: Mode behavior follows Claude semantics

- **WHEN** 调用分别处于 `default`、`acceptEdits`、`plan`、`auto`、`dontAsk` 或 `bypassPermissions`
- **THEN** 系统 MUST 按对应 Claude 权限行为产生最终决策
