## ADDED Requirements

### Requirement: Auto Memory Index Is Loaded Automatically and Bounded

`autoMemoryEnabled` MUST 默认开启。会话启动时，记忆子系统 MUST 由宿主直接读取 `MEMORY.md` 前 200 行或前 25KB（先到者为准），并作为低权限 context 自动注入；该宿主读取 MUST NOT 进入工具审批。

#### Scenario: A session starts with an index

- **WHEN** 当前项目启用 Auto Memory 且 `MEMORY.md` 存在
- **THEN** 会话 MUST 自动注入有界索引
- **THEN** 用户 MUST NOT 收到 Read 工具审批

#### Scenario: An index exceeds a limit

- **WHEN** `MEMORY.md` 超过 200 行或 25KB
- **THEN** 启动投影 MUST 只包含限制内的完整内容
- **THEN** 诊断 MUST 说明截断原因和限制

#### Scenario: Topic files exist

- **WHEN** `MEMORY.md` 引用 topic 文件
- **THEN** 会话启动 MUST NOT 打开或注入 topic 内容
- **THEN** Agent MUST 按需通过标准文件工具读取

### Requirement: Default Memory Root Has Claude-Style File Permission

文件权限层 MUST 明确识别当前项目默认 Auto Memory 根和 Agent memory 根。显式 deny/hard cap MUST 先评估；随后默认根内的 Read/Edit/Write 以及映射为 Write 的 `createDirectory` MUST 在危险目录检查和普通 ask 之前 allow。

#### Scenario: Manual writes a topic in the default root

- **WHEN** 当前模式为 Manual，Agent 在默认 memory 根内创建 `topics/`、写 topic 或更新 `MEMORY.md`
- **THEN** 系统 MUST 直接允许
- **THEN** 系统 MUST NOT 弹审批或切换到 Accept edits on

#### Scenario: A memory write targets a sibling directory

- **WHEN** 目标位于 projectDataDir 中但不在精确 memory 根内
- **THEN** memory allow MUST NOT 生效

#### Scenario: A destructive memory operation is requested

- **WHEN** Agent 请求删除、移动、执行 memory 文件或修改 settings/instructions
- **THEN** 系统 MUST 按相应高风险或 protected 策略评估
- **THEN** Read/Edit/Write 特例 MUST NOT 泛化到该操作

### Requirement: Custom Auto Memory Directory Follows Claude Boundaries

`autoMemoryDirectory` MUST 只接受规范化绝对路径或 home-relative 路径。项目/local 来源 MUST 在工作区获得信任后生效。自定义根内读取 MUST 允许；写入 MUST 进入普通权限流程，除非存在显式 allow rule。

#### Scenario: A custom root is read

- **WHEN** 可信配置选择自定义 memory 根，Agent 按需读取其中 topic
- **THEN** 文件权限层 MUST 允许读取

#### Scenario: A custom root is written without a rule

- **WHEN** Manual 模式下 Agent 写入自定义 memory 根且没有显式 allow rule
- **THEN** 系统 MUST 返回 `ask`

#### Scenario: An untrusted project config selects a custom root

- **WHEN** 未建立工作区信任的项目/local 配置指定工作区外 memory 根
- **THEN** 系统 MUST 忽略该覆盖并记录去敏告警

### Requirement: Background Memory Agent Uses a Restricted Tool Policy

后台记忆整理 Agent MUST 使用独立 caller 和与 Claude `createAutoMemCanUseTool()` 等价的工具策略：允许 Read/Grep/Glob、只读 Bash，以及仅限 memory 根的 Edit/Write；其他工具 MUST 拒绝。

#### Scenario: The background agent writes memory

- **WHEN** 后台记忆 Agent 编辑精确 memory 根内文件
- **THEN** 操作 MUST 允许并记录 `extract_memories` 等独立审计来源

#### Scenario: The background agent writes outside memory

- **WHEN** 后台记忆 Agent 尝试在 memory 根外 Edit/Write、执行有副作用 Shell、调用 MCP 或发送外部消息
- **THEN** 受限工具策略 MUST 拒绝

### Requirement: Memory Operation Trust and Content Trust Are Separate

默认 memory 根的文件操作 allow MUST NOT 提升 memory 内容的指令权重。memory MUST 保持 provenance、可审计、可撤销，并与 instructions、权限设置、caller identity 和系统策略隔离。

#### Scenario: Memory contains a permission instruction

- **WHEN** `MEMORY.md` 声称应启用 bypass、扩大目录或忽略 host policy
- **THEN** 权限系统 MUST 忽略该内容作为授权来源

#### Scenario: An untrusted channel produces a candidate memory

- **WHEN** 网页、邮件、共享聊天或未知 MCP 内容触发记忆候选
- **THEN** 候选 MUST 进入带 provenance 的暂存状态
- **THEN** 未通过记忆策略前 MUST NOT 作为激活的稳定事实注入

## REMOVED Requirements

### Requirement: 记忆索引加载必须有界且可诊断

**Reason:** 原 Requirement 使用 20KB 上限并在启动时读取 topic frontmatter，不符合 Claude 的 25KB 与 topic 按需读取行为。

**Migration:** 使用 `Auto Memory Index Is Loaded Automatically and Bounded`。

### Requirement: 记忆维护必须复用标准文件工具

**Reason:** 原 Requirement 没有默认 memory 根的内建 allow，导致 Manual 模式反复审批。

**Migration:** 标准文件工具继续使用，但由 `Default Memory Root Has Claude-Style File Permission` 提供精确特例。

### Requirement: 第一版不得执行自动抽取或语义检索

**Reason:** 用户已选择 Claude Auto Memory 方案，需要受限后台记忆 Agent；语义检索仍不是本 change 必需能力。

**Migration:** 使用 `Background Memory Agent Uses a Restricted Tool Policy`；不因此引入向量检索。
