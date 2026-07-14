## 背景

MyAgent 已存在 Claude 风格的 `PermissionMode`、`PermissionRuleStore`、`ToolPermissionService`、`PermissionPromptAdapter` 和不可伪造的 `AuthorizedExecutionContext`，但运行时迁移尚未完成：

- `ToolRegistry` 在 `ToolCallGateway` 之外直接调用 `ToolPermissionService`、解释 `ask` 并等待审批，然后只使用 Gateway 的 `executeAuthorized()`；MCP 路径又复制一套相同流程。
- `ToolCallGateway.execute()` 只接受最终 `allow`，不能协调 ask-only 提示，因此没有成为真正的唯一入口。
- `SessionManager` 已停止注册 `HumanApprovalPlugin`，但组合根、构造参数、`ToolRegistry.policyPort`、`ToolPolicyPort`、策略适配器和各工具 `checkSafety()` 仍然存在。
- 终端工具分别在 `checkSafety()`、`checkPermissions()`、`resolveExecutionEffect()` 和执行期 `validateCommand()` 中重复推断命令副作用；执行结果又可能被静态 `securityCategory` 覆盖。
- 当前复合命令试验使用一个轻量字符扫描器处理多个 Shell family，并在解析降级时无条件把整体风险改为 `unknown`，可能覆盖已经发现的 `hardline`。
- 主规格同时存在“复合命令逐子命令评估”和“所有复合字符一律拒绝”两种相互冲突的要求。

阶段 3 按 3A/3B/3C 的依赖顺序完成统一分析契约、唯一权限/执行链和基础复合命令放开。原阶段 5 收缩为复杂复合语法扩展，不再承载首个可用的复合命令能力。

## 目标与非目标

**目标:**

- 为 POSIX、PowerShell 和 CMD 建立显式分发的命令分析契约，不再用一个跨 Shell 正则表达完整语义。
- 放开 Bash 顶层 `;`、`&&`、`||` 和 PowerShell 顶层 `;`，对拆分后的每个原子子命令执行安全分析与权限聚合。
- 保证 hardline/deny 证据在解析失败、能力降级、显式 ask、allow 规则和所有权限模式下都不可被覆盖。
- 同一次工具权限评估只生成一次命令分析，并让分析证据贯穿权限决策、授权上下文、工具执行和 effect 结算。
- 让 `ToolCallGateway + ToolPermissionService + PermissionPromptAdapter` 成为 NativeTool、MCP 和 tail call 的唯一权限与 ask 交互入口。
- 删除旧 `ToolPolicyPort/checkSafety/HumanApprovalPlugin` 决策路径，完成主规格已经声明的零残留迁移。
- 保持模型可见工具名称、工具参数 Schema 和现有 PermissionMode 不变。

**非目标:**

- 不实现完整 Bash、PowerShell 或 CMD 语言解析器，不引入新的生产解析依赖。
- 不支持管道、重定向、后台执行、换行、子 Shell、命令替换、脚本块、控制流、CMD 复合语法或其他阶段 3 未覆盖的 Shell 结构。
- 不实现 Docker、WSL2、Windows restricted token、ACL、Firewall 等 OS 沙盒能力。
- 不删除自动代码质量门禁；本阶段只保证它消费的 effect 来源可信。
- 不复制 Claude Code 的后台分类器、Hook defer 或产品 UI。
- 不改变 Read/Write/Edit 等工具的业务语义，只迁移其权限证据和唯一入口。

## 架构决策

### 1. Shell 分析采用统一契约、分 Shell 实现

在 `src/adapters/tools/impl/system/command-analysis/` 新增独立模块：

- `types.ts`：定义只读的 `ShellCommandAnalysis`、`CommandSegmentAnalysis`、`CommandRiskSignal` 与 `ShellCommandAnalyzer`。
- `analyze-shell-command.ts`：只负责根据已经决议的 `ResolvedShellKind` 分发，不猜测 Shell。
- `posix-command-analyzer.ts`、`powershell-command-analyzer.ts`、`cmd-command-analyzer.ts`：分别处理各 Shell 的引号、转义、命令名规范化和原子命令副作用分类。
- `hardline-command-scanner.ts`：按 Shell family 执行不可绕过的最低限度 deny 扫描；它在支持性判断之前运行，也在解析失败时运行。

`ShellCommandAnalysis` 至少包含：

- `shellKind`；
- `parseStatus: parsed | unsupported | invalid`；
- `commandShape: atomic | compound | nested`；
- 原子命令及其规范命令名、参数和资源；
- `sideEffect: read | sensitive-read | write | unknown | hardline`；
- 结构化风险信号与面向用户的风险摘要；
- 可选的原子命令规则建议，供 session/persistent 授权使用。

阶段 3 对可证明为原子命令的输入，以及只由以下顶层连接符组成且每段均为可分析原子命令的输入返回 `parsed`：Bash 的 `;`、`&&`、`||`，PowerShell 的 `;`。分析结果按原顺序保存 `subcommands` 和连接关系，供权限聚合与执行语义复用。管道、重定向、后台符号、换行、脚本块、控制流、CMD 复合语法或嵌套命令返回 `unsupported`；不平衡引号、转义或非法结构返回 `invalid`。引号内的普通字面量不得被误判为结构操作符。

首批连接符使用分 Shell、引号与转义感知的有限状态扫描器，不引入完整 AST 依赖。它只对明确列出的顶层连接符声明支持；任何超出语法子集的结构均不可执行，从而避免把近似解析结果当成安全证明。后续扩展管道、重定向与嵌套语法时必须重新评估 Bash parser 和 PowerShell 原生 AST。

### 2. 解析状态和风险等级分开建模

`parseStatus` 只表示分析能力，不直接覆盖 `sideEffect`。聚合规则固定为：

1. 任意 hardline/deny 证据使最终分析保持 `hardline`；
2. 没有 hardline 时，`invalid` 或 `unsupported` 使命令不可执行；
3. 对已支持的原子或复合命令，先逐子命令分析，再按 `unknown > write > sensitive-read > read` 聚合整体副作用。

禁止使用“解析失败后直接赋值为 unknown”的实现，因为该写法会丢失先前发现的拒绝证据。`COMPOSITE_REGEX` 可以在迁移期间作为诊断特征，但不得继续充当跨 Shell 解析器或最终权限决策器。

### 3. 工具检查返回决策建议和通用证据

在权限领域类型中新增 `ToolPermissionEvidence`，作为 `ToolPermissionCheckResult` 和最终 `PermissionDecision` 的可选附加数据。它复用现有 `SafetyResource`，包含操作类别、副作用、资源、风险原因和可选的 Shell 分析结果，但不新增最终权限状态。

终端 `checkPermissions()` 只调用一次 `analyzeShellCommand()`。原子子命令分别生成权限建议，复合命令按固定规则汇总：任一 deny 则整体 deny，任一 ask 则整体 ask，只有全部 allow 才整体 allow。具体映射为：

- `hardline`、`invalid`、`unsupported` → `deny`；
- 普通读取 → `allow`；
- 敏感读取、写入、未知原子命令 → `ask`；
- 无法由工具决定且没有危险证据 → `passthrough`。

阶段 3 将 `unsupported` 设为 deny，但已支持的基础连接符返回 `parsed` 并进入逐子命令聚合。单条复合命令最多分析 50 个子命令，超过上限按 `unsupported` 拒绝；这是防止输入规模绕过和分析成本失控的固定安全边界。

当用户为复合命令选择 session 或 persistent 授权时，`PermissionUpdate` 只为实际需要批准的原子子命令生成规则，单次最多建议 5 条；不得把完整复合字符串保存为一条宽泛 allow 规则。

其他内建工具也在现有 `checkPermissions()` 中附带同一证据格式。MCP 工具根据服务注解和访问元数据生成证据；无可信元数据时使用 `unknown` 并进入 ask，不得按 read 自动放行。

### 4. 权限服务先收集规则和工具结果，再统一聚合

当前 `ToolPermissionService` 在命中全局 ask 规则后可能提前返回，导致工具 hardline deny 没有运行。新的固定顺序为：

1. 收集匹配的全局 deny/ask/allow 规则；
2. 执行一次工具 `checkPermissions()` 并取得 evidence；
3. 按 `deny > ask > allow > passthrough` 聚合规则和工具结果；
4. 只有聚合结果不是 deny 时才执行 PermissionMode 后处理；
5. 生成唯一的 `PermissionDecision`，并原样携带 evidence。

显式 ask 不能跳过工具 deny；allow 规则不能覆盖 hardline、invalid 或 unsupported；`auto`、`bypassPermissions` 只能处理允许进入模式后处理的 ask，不能改变 deny。

### 5. Gateway 协调授权，PromptAdapter 只处理 ask

`ToolCallGateway` 调整为不解释具体工具语义的授权协调器：

```text
ToolRegistry 路由本地或 MCP 目标
  -> ToolCallGateway 请求 ToolPermissionService 评估
  -> deny：返回拒绝，不执行
  -> ask：PermissionPromptAdapter 展示并应用 once/session/persistent 结果
  -> allow：签发一次性 AuthorizedExecutionContext
  -> 目标执行器消费上下文并返回 ToolExecutionOutcome
```

Registry 只提供目标工具的 checker、执行函数和访问元数据，不再直接调用 `ToolPermissionService`、`waitApproval()` 或创建 allow 决策。NativeTool、MCP 和 tail call 都调用同一个 Gateway API。

`PermissionPromptAdapter` 通过组合根注入的 handler 适配 `SessionContext.waitApproval()`；它只消费最终 ask，不解释 Plan、Auto、风险分类或 hardline。once 只授权当前调用；session/persistent 只应用决策携带的 `PermissionUpdate`，不得从 UI choice 临时拼出第二种规则格式。

选择扩展现有 Gateway 和 PromptAdapter，而不是保留 Registry 内审批，是因为主规格已经规定 Gateway 为统一入口；继续保留两套流程只会让本地、MCP 和 tail call 的模式语义再次漂移。

### 6. 分析证据随授权上下文进入 effect 结算

`AuthorizedExecutionContext` 增加只读 `evidence`。`ToolExecutor.executeAuthorized()` 使用 evidence 生成 `ToolExecutionEffect`，并根据实际执行结果填写 `executionStarted` 和 `completed`：

- `read`、`sensitive-read` → read effect；
- `write` → write effect；
- `unknown` → unknown effect；
- hardline/invalid/unsupported 不会获得授权上下文；已支持复合命令携带子命令 evidence 和聚合 effect；
- 缺少 evidence 的迁移期调用按 unknown 降级，不能使用静态 `securityCategory=read` 提升为 read。

Gateway 返回完整 `ToolExecutionOutcome`。Registry 不再把 Executor 的 effect 覆盖为静态默认值。这样自动质量门禁、日志和 Plan 语义消费的是权限阶段同一份分析证据，而不是执行后再次解析命令。

### 7. 旧策略端口执行零残留删除

当所有工具 `checkPermissions()` 都能返回必要 evidence，删除：

- `NativeTool.checkSafety()` 与 `resolveExecutionEffect()` 兼容接口；
- `ToolPolicyPort`、`SafetyCheckResult` 和 `PlanSideEffect`；
- `BuiltinToolPolicyAdapter`、`ExternalToolPolicyAdapter`、`ToolPolicyRouter`；
- 未装配的 `HumanApprovalPlugin` 及旧 `ApprovalPolicy`/pending grant 兼容代码；
- `ToolRegistry.policyPort`、`SessionManager` 的 `_toolPolicyPort`/旧元数据参数和组合根传参。

`SafetyResource` 继续作为通用资源描述使用，但从旧策略命名中解耦。BeforeTool/AfterTool 插件管线继续承载非权限生命周期能力，不再承担权限判断或人工审批。

## 风险与权衡

- **有限状态扫描器不能覆盖完整 Shell 语言** → 只对明确列出的顶层连接符声明支持，复杂结构继续拒绝；管道、重定向和嵌套语法必须在后续引入更强解析能力后开放。
- **复合命令一次批准可能产生过宽规则** → 权限建议按需要批准的原子子命令生成，并限制单次建议数量，禁止保存整串复合命令。
- **删除 `checkSafety()` 涉及较多内建工具** → 先为每个工具建立 `checkPermissions + evidence` 契约测试，再删除旧接口；最终以旧符号零残留作为门槛。
- **权限服务从短路判断改为聚合可能改变边缘规则结果** → 使用 deny/ask/allow、Plan、Auto、Bypass、MCP 和 tail call 参考夹具锁定 Claude 语义。
- **evidence 随授权上下文传递会扩大内部类型** → evidence 保持只读、与最终决策状态正交，不允许执行器修改或重新解释权限。
- **无 AST 的 Shell 感知词法分析仍不可能覆盖完整语言** → `unsupported` 明确表达能力缺口；禁止以近似分析结果进入 allow。
- **MCP 缺少可信副作用元数据** → 默认 unknown/ask，只有明确注解或规则才能提升自动化程度。
- **旧 effect 消费者依赖静态 securityCategory** → 在迁移测试中同时断言权限 evidence 与最终 effect，迁移完成后移除静态覆盖路径。

## 迁移计划

1. 新增权限 evidence 和 Shell 分析类型，建立 hardline 优先、解析状态、引号/转义和原子命令夹具；此时旧运行时行为不切换。
2. 实现三个 Shell 分析器和统一分发入口；先锁定原子命令行为，再实现 Bash `;`/`&&`/`||` 与 PowerShell `;` 的顶层拆分、连接关系和子命令数量上限。
3. 先迁移终端 `checkPermissions()`，再迁移文件、浏览器、Git、交互和 MCP 工具，使每个工具提供 evidence。
4. 调整 `ToolPermissionService` 为规则与工具结果聚合，修复 ask 提前返回和 hardline 被模式覆盖的问题。
5. 接入 `PermissionPromptAdapter`，让 Gateway 完成本地、MCP 和 tail call 的一次性授权、按子命令生成规则更新和执行；Registry 停止直接判断权限。
6. 将 evidence 写入授权上下文并由 Executor 生成 effect；验证质量门禁和日志仍能得到正确的 read/write/unknown 结果。
7. 删除旧策略端口、插件、兼容字段、组合根参数和重复测试；执行旧符号零残留检查。
8. 放开已支持的基础复合命令执行，运行 TypeScript、Lint、权限/终端单元测试、Registry/MCP/tail call 集成测试和完整回归；用运行日志确认一次复合调用只产生一次聚合权限决策与至多一次 ask。

迁移期间允许旧适配器只作为编译过渡存在，但不得同时参与同一调用的最终决策。若某一检查点失败，恢复到上一检查点的单一路径；发布层回滚使用上一可用构建产物，不引入双写或持久数据迁移。

## 待确认问题

没有阻塞阶段 3 的开放问题。首批语法和规则建议上限已固定；管道/重定向/嵌套语法所需的 Bash/PowerShell AST 依赖、OS 沙盒后端和 Hook defer 均明确延期到后续 change。
