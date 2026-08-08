# Subagent Memory

## Purpose

定义子代理定义级持久记忆契约（`memory: user | project | local` 三域）：记忆目录解析与类型名消毒、启动注入有界快照与记忆行为提示词、任务级记忆根权限与保留名保护。对齐 Claude Code `agentMemory.ts` 语义，复用主记忆平铺文件契约（`MEMORY.md` + 同层 `<slug>.md`），机制独立（子代理不继承主会话 Auto Memory）。

## Requirements

### Requirement: 子代理定义可声明持久记忆作用域

子代理定义 frontmatter 必须（MUST）支持可选 `memory` 字段，取值必须（MUST）为 `user`、`project` 或 `local` 三者之一；声明非法值（非这三者或非字符串）时，定义必须（MUST）被拒绝注册（fail-closed）。未声明 `memory` 时，子代理行为必须（MUST）与未启用该能力前一致（无记忆注入、无记忆目录权限、无快照）；fresh 与恢复型子代理不得（MUST NOT）继承主记忆规则（对齐官方「不向子代理加载主会话 Auto Memory」），exact-fork 型子代理必须（MUST）保留父会话 system 原文（含主记忆规则，属既有 fork 语义）。定义声明 `memory` 后，系统必须（MUST）在子代理启动时加载对应作用域的持久记忆；该注入必须（MUST）受 `autoMemoryEnabled` 全局开关门控（提交点冻结当前会话运行时值，排队任务不读过期配置）——关闭时定义仍可注册、字段解析生效，但运行时不得（MUST NOT）注入记忆快照、提示词、权限或工具补齐（行为同未声明）。

#### Scenario: 定义声明合法 memory 值

- **WHEN** 子代理定义 frontmatter 声明 `memory: project`
- **THEN** 该定义注册成功并携带 `project` 作用域
- **AND** 启动该子代理时注入对应作用域的记忆

#### Scenario: 定义声明非法 memory 值

- **WHEN** 子代理定义 frontmatter 声明 `memory: team`（或 `memory: true` 等非三值）
- **THEN** 该定义被拒绝注册
- **AND** 诊断日志记录非法值原因

#### Scenario: 定义未声明 memory

- **WHEN** 子代理定义未声明 `memory` 字段
- **THEN** 该定义不携带记忆作用域
- **AND** 启动行为与未启用该能力前一致（system 不含主记忆规则，也不含专属记忆提示词）

#### Scenario: autoMemoryEnabled 关闭时不注入记忆

- **WHEN** `autoMemoryEnabled` 为 false 且定义声明 `memory: user`
- **THEN** 定义注册成功（字段解析生效）
- **AND** 子代理启动时不注入记忆快照、专属提示词与记忆目录权限
- **AND** 行为与未声明 memory 一致

### Requirement: 记忆目录按作用域解析并消毒类型名

声明 `memory` 的子代理，其记忆目录必须（MUST）按作用域解析：`user` 为 `<userConfigDir>/agent-memory/<type>/`，`project` 为 `<workspace>/.myagent/agent-memory/<type>/`，`local` 为 `<projectDataDir>/agent-memory-local/<type>/`。类型名必须（MUST）通过安全名称校验：禁止 `/`、`\`、`.`、`..`、绝对路径形态与 Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9，含任意扩展名形态与尾随点/空格），非法名称的定义必须（MUST）被拒绝注册；其中 `:`（插件命名空间）必须（MUST）替换为 `-` 后作为目录名（Windows 兼容）。解析后的目录必须（MUST）位于对应作用域基座之内（子路径断言，防逃逸）。目录不存在或 `MEMORY.md` 缺失时，记忆必须（MUST）视为空记忆（空快照），不得（MUST NOT）因读取记忆而创建目录或文件，也不得（MUST NOT）阻断子代理启动。

#### Scenario: 三个作用域解析到各自基座

- **WHEN** 子代理类型 `reviewer` 声明 `memory: user`，且 `userConfigDir` 为 `~/.myagent`
- **THEN** 记忆目录解析为 `~/.myagent/agent-memory/reviewer/`
- **AND** 声明 `project`/`local` 时分别解析为 `<workspace>/.myagent/agent-memory/reviewer/` 与 `<projectDataDir>/agent-memory-local/reviewer/`

#### Scenario: 插件命名空间类型消毒

- **WHEN** 子代理类型为 `my-plugin:reviewer` 且声明 `memory: user`
- **THEN** 记忆目录解析为 `<userConfigDir>/agent-memory/my-plugin-reviewer/`

#### Scenario: 危险类型名拒绝注册

- **WHEN** 定义 `name` 为 `../shared`、绝对路径形态或 `CON` 等 Windows 保留设备名
- **THEN** 该定义被拒绝注册（fail-closed）
- **AND** 诊断日志记录安全名称校验失败原因

#### Scenario: 记忆目录不存在

- **WHEN** 声明的记忆目录或其 `MEMORY.md` 不存在
- **THEN** 子代理获得空记忆快照
- **AND** 系统不创建目录或文件，子代理正常启动

### Requirement: 启动注入有界快照与记忆行为提示词

声明 `memory` 的子代理启动时，系统必须（MUST）读取该目录 `MEMORY.md` 的有界内容（对齐主记忆契约：前 200 行或前 25KB，先到者为准，不可变冻结）并作为低权限 context 注入模型请求；记忆索引不得（MUST NOT）写入会话历史。同时必须（MUST）在子代理 system prompt 追加记忆行为提示词段，至少包含：作用域说明（`user` 跨项目通用、`project` 随版本控制共享、`local` 本项目本机）、记忆目录的绝对路径指引、平铺写入两步流程（先写 `<slug>.md` 主题文件并带 frontmatter 三字段 `name`/`description`/`type`，其中 `type` 为 `user`/`feedback`/`project`/`reference` 四值，再更新 `MEMORY.md` 索引 `- [Title](<slug>.md) — one-line hook`）、复用与更新规则、忘记操作先删事实源再删索引，以及 `memory.md` 保留名禁令。声明 `memory` 的子代理工具面必须（MUST）保证 Read/Write/Edit 对应工具（readFile/writeFile/editFile）可见，定义级 `tools` 允许名单不得（MUST NOT）将其过滤；显式 `disallowedTools` 剔除名单必须（MUST）仍生效（豁免语义为 `(tools ∪ 记忆必需工具) - disallowedTools`）。

#### Scenario: 有记忆索引的子代理启动

- **WHEN** 声明 `memory: local` 的子代理启动且其记忆目录存在 `MEMORY.md`
- **THEN** 系统注入有界索引快照（不打开主题正文文件）
- **AND** system prompt 包含作用域说明与记忆写入规则
- **AND** 索引快照不进入持久化会话历史

#### Scenario: 空记忆目录的子代理启动

- **WHEN** 声明 `memory` 的子代理启动且记忆目录为空
- **THEN** 系统注入空快照
- **AND** system prompt 仍包含记忆行为提示词（含绝对 `memoryDir` 指引），模型可据此创建第一份记忆

#### Scenario: 定义级 tools 名单不削减记忆维护工具

- **WHEN** 声明 `memory` 的子代理定义同时声明 `tools: [globSearch, grepSearch]`（不含文件读写工具）
- **THEN** 子代理工具面仍包含 readFile/writeFile/editFile
- **AND** 记忆维护必需工具不被定义级允许名单过滤

#### Scenario: 显式剔除名单仍生效

- **WHEN** 声明 `memory` 的子代理定义声明 `disallowedTools: [writeFile]`
- **THEN** writeFile 仍被剔除（记忆工具豁免不得覆盖显式剔除名单）
- **AND** readFile/editFile 等其余记忆维护工具保持可见

### Requirement: 任务级记忆根权限且保留名受保护

运行中的子代理任务，其声明的记忆目录必须（MUST）冻结于任务自身的权限状态（per-task，不共享进程级状态）：根内 Read/Edit/Write/createDirectory 必须（MUST）直接 allow（不弹审批，含 ReadFile/ListFiles/readManyFiles 等读工具），delete/move/execute 不得（MUST NOT）继承该特例；未声明 memory 的任务或未冻结的目录不得（MUST NOT）享有任何特例。判定必须（MUST）基于资源证据的物理路径（全部资源须位于同一冻结记忆根内，符号链接/junction 不得把特例带到根外文件）。`memory.md` 保留名保护必须（MUST）对冻结的记忆根生效且先于显式权限规则（大小写折叠等于 `memory.md` 且原形不等于 `MEMORY.md` 的写/建目标返回 deny；原形 `MEMORY.md` 放行）。记忆根 allow 必须（MUST）允许权限模式继续收窄（如 plan 模式拒绝写类操作）。任务结束权限状态随任务销毁，不产生残留。

#### Scenario: 激活目录内写记忆免审批

- **WHEN** 声明 `memory: project` 的子代理运行中写入其记忆目录内的主题文件或 `MEMORY.md`
- **THEN** 系统直接允许
- **AND** 不弹审批

#### Scenario: 读工具访问记忆根免审批

- **WHEN** 声明 `memory: user` 的子代理运行中通过 readFile/listFiles 读取其记忆根内文件
- **THEN** 系统直接允许（user 域在授权工作区之外同样生效）
- **AND** 不弹审批

#### Scenario: 记忆根内保留名被拒绝

- **WHEN** 运行中的子代理尝试写入冻结记忆根内的 `memory.md`（大小写变体）
- **THEN** 系统返回 deny
- **AND** 对原形 `MEMORY.md` 的索引更新仍正常放行

#### Scenario: 并发任务权限隔离

- **WHEN** 两个子代理任务并发运行，分别声明不同（或相同）的记忆目录
- **THEN** 各任务只对其自身冻结的记忆根享有特例
- **AND** 任一任务无法借另一任务的记忆根获得权限
- **AND** 一个任务结束不影响另一任务的记忆根权限

#### Scenario: 任务结束权限不残留

- **WHEN** 子代理任务结束（含异常与取消路径）
- **THEN** 其记忆目录不再享有特例
- **AND** 后续其他任务对该目录的写入走普通权限流程
