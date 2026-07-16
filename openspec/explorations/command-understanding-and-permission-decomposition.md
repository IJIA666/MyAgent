# 命令理解与权限判定问题拆解

> 分析开始日期：2026-07-16  
> 分析对象：MyAgent 的 Shell 命令生成、结构解析、语义识别、资源分析、权限策略与执行生命周期  
> 参考基线：Claude Code 的实际使用表现与本地源码；必要时补充 OpenCode、Hermes Agent、OpenClaw 证据  
> 分析目的：把“复杂命令无法识别”拆成可独立验证的原子问题，先形成可靠边界，不在本阶段直接修改实现

## 1. 背景与问题定义

当前表象是：模型生成了一条用于只读调查的复杂 PowerShell 命令，MyAgent 将其判定为“无法静态证明命令副作用”，继而要求审批。继续为某个具体语法增加白名单，只能暂时消除一个误报，无法说明同类命令为什么安全，也无法保证危险变体仍会被拦截。

Claude Code 的实际回答提供了反例：它能够直接执行包含以下结构的磁盘调查命令：

- 多级管道；
- `ForEach-Object { ... }` 脚本块；
- 脚本块内的局部变量赋值；
- `if` 条件分支；
- `[math]::Round(...)` 静态方法调用；
- `[PSCustomObject]@{ ... }` 对象投影；
- 递归文件枚举和聚合统计。

因此，问题不能简单归因为“复刻 Claude Code 后变得保守”。更准确的初始假设是：MyAgent 只吸收了部分 AST 风险特征，却没有建立从结构证据到行为语义、资源访问和最终权限结论的完整分层。

## 2. 分析原则

1. **结构与策略分离**：解析器只描述命令是什么结构，不直接决定 `allow/ask/deny`。
2. **行为与资源分离**：是否写入系统，与是否访问项目外或敏感路径是两个维度。
3. **证据与结论分离**：脚本块、赋值、成员调用只是证据，不天然等于危险行为。
4. **原子问题独立验收**：每个问题必须有明确输入、输出、反例和完成标准。
5. **先事实后设计**：先核对 MyAgent 当前实现和参考项目真实行为，再提出边界调整。
6. **不为单个评测硬编码**：C 盘调查命令仅作为黑盒验收样例，不作为生产规则来源。
7. **最终保留端到端验证**：原子测试通过不等于综合体验正确，最后仍需用正常对话验证完整链路。

## 3. 原子问题与依赖顺序

```text
模型提示与工具描述
        ↓
Shell 结构解析
        ↓
原子命令语义 ─────────┐
        ↓              │
表达式与脚本块语义      │
        ↓              │
嵌套行为聚合            │
        ├──────────────┘
        ↓
资源与路径分析
        ↓
权限策略聚合
        ↓
审批与执行生命周期
        ↓
日志、解释与端到端体验
```

实际分析顺序从结构解析开始；模型提示放到后段分析，避免用提示词掩盖底层能力缺口。

| 编号 | 原子问题 | 核心问题 | 独立产物 |
|---|---|---|---|
| 1 | Shell 结构解析 | 能否无损还原真实执行单元和嵌套关系 | AST 结构契约与解析测试矩阵 |
| 2 | 原子命令语义 | 单个 cmdlet/程序的基础副作用是什么 | 命令能力分类边界 |
| 3 | 表达式与脚本块语义 | 局部计算、赋值、方法调用是否改变外部状态 | 表达式行为分类规则 |
| 4 | 嵌套行为聚合 | 容器命令如何继承内部行为 | 自底向上的 effect 聚合规则 |
| 5 | 资源与路径分析 | 命令实际读取或写入哪些资源 | 资源证据与动态路径策略 |
| 6 | 权限策略 | 如何将行为、资源和用户规则合成权限结论 | `allow/ask/deny` 决策契约 |
| 7 | 审批与执行生命周期 | 审批等待、拒绝和执行失败如何区分 | 生命周期状态机与 effect 语义 |
| 8 | 模型提示与工具描述 | 模型是否准确理解当前工具能力 | 最小且动态的能力说明 |
| 9 | 可观测性与综合验收 | 能否解释每层结论并复现问题 | 分层日志与对话测试用例 |

## 4. 逐项分析记录

### 4.1 Shell 结构解析

**状态：已完成第一轮分析并落实 PowerShell 结构层改造**

> 2026-07-16 实施校正：原建议中的“先建设共享 Shell IR”属于 MyAgent 自主设计，不是 Claude Code 已验证方案。结合用户实际 Claude Code 体验与本地不同版本源码后，本项收敛为：先参考 Claude Code 的领域投影方式，完整保留 PowerShell 原生 AST 证据；暂不建设跨 Shell 的统一树模型。Claude Code 的实际表现作为黑盒验收基线，本地源码用于借鉴机制，不机械复制旧版本的保守权限结论。

#### 4.1.1 MyAgent 当前链路

PowerShell 复杂命令当前经过以下步骤：

```text
PowerShellCommandAnalyzer
  -> analyzeWithProfile()
     -> scanHardlineCommand()
     -> scanShellCommandStructure()       字符级扫描并拆分 segment
     -> analyzeAtomicCommand()            对字符扫描结果做命令分类
  -> 简单原子命令可能直接返回
  -> 复杂命令调用 PowerShellAstParser
     -> 原生 Parser::ParseInput()
     -> FindAll(CommandAst)
     -> 扁平化为 ShellCommandSyntaxNode[]
  -> analyzeParsedPowerShell()
     -> 再次对 AST 命令节点调用 analyzeAtomicCommand()
     -> 聚合副作用和权限
```

POSIX 路径也存在类似双层解析：先用 `scanShellCommandStructure()` 生成基础分析，再用 `shell-quote` 生成第二份结构，最后由 `mergeStructureEvidence()` 按数组下标合并。

涉及的 MyAgent 源码：

- `src/adapters/tools/impl/system/command-analysis/shell-command-scanner.ts`
- `src/adapters/tools/impl/system/command-analysis/analyze-with-profile.ts`
- `src/adapters/tools/impl/system/command-analysis/powershell-ast-parser.ts`
- `src/adapters/tools/impl/system/command-analysis/powershell-command-analyzer.ts`
- `src/adapters/tools/impl/system/command-analysis/posix-structure-parser.ts`
- `src/adapters/tools/impl/system/command-analysis/posix-command-analyzer.ts`

#### 4.1.2 已确认的结构缺口

**缺口一：存在两个结构事实源。**

字符扫描器先拆出 `segments`，Shell 专用解析器再输出 `nodes`。两者对嵌套、连接符和表达式的理解不同。PowerShell 成功解析后虽然已经改为使用 AST 节点重建命令，但字符扫描结果仍然参与前置状态、能力开关和 hardline 快速路径；POSIX 路径仍按数组下标合并两套结果。结构层无法给出“哪个结果才是最终事实”的统一保证。

**缺口二：通用字符扫描器不维护嵌套深度。**

`scanShellCommandStructure()` 遇到 `()` 或 `{}` 只设置 `nested=true`，没有维护括号、花括号的进入和退出深度。因此，脚本块或哈希表内部的 `;`、`|` 仍可能被当作顶层连接符。此前计算属性和 `ForEach-Object` 命令被重复拆分，就是这个模型的直接后果。这个扫描器可以作为便宜的异常预检，但不能作为复杂命令的结构解析器。

**缺口三：PowerShell AST 被压缩成扁平 CommandAst 列表。**

当前原生脚本使用 `FindAll(CommandAst)` 提取命令，并输出 `statementStart`、`statementType`、`parentStart`、`pipelineIndex` 等少量元数据。TypeScript 再根据 offset 推导 `nodePath`。这种表示保留了“有哪些命令”，却没有保留完整的：

- statement 自身及其正文；
- pipeline chain 的真实连接关系；
- `CommandExpressionAst` 等非命令表达式；
- 赋值的左值、右值和变量 scope；
- 参数与其子表达式的对应关系；
- 方法调用的 receiver、类型和 method；
- 控制流分支和命令分别属于哪个 body；
- type literal、using statement、script requirement 等执行语义证据。

后续模块只能看到“存在赋值”“存在成员调用”等全局布尔值，无法回答“哪个赋值写了什么”“哪个方法在哪个对象上调用”。这不是权限策略过于保守造成的，而是结构层已经丢失了做精细判断所需的证据。

**缺口四：部分已提取信息在跨进程归一化时丢失。**

PowerShell 解析脚本会为每个命令计算 `dynamicArguments` 和 `dynamicCommand`，但 `RawPowerShellNode` 与 `ShellCommandSyntaxNode` 没有接收这两个节点级字段。最终只剩全局 `hasDynamicArguments` 和 `hasDynamicCommands`，无法定位到具体子命令。这会迫使权限层把整条复合命令一起降级。

**缺口五：connector 是二次猜测，不完全来自 AST。**

当前 TypeScript 归一化逻辑通过相邻命令 source range 之间的文本推测 `;`、`&&`、`||`，并把 pipelineIndex 大于零统一映射为 `|`。这对简单命令有效，但对 pipeline chain、嵌套 statement、表达式管道和不同 PowerShell 版本的语法不构成完整模型。

**缺口六：POSIX 的 `shell-quote` 只是词法基础，不是完整 Shell AST。**

它适合识别普通引号、词和基础操作符，但对子 Shell、命令替换、here document、process substitution、函数和复杂重定向无法提供完整层级。当前阶段若明确把这些结构归为 unsupported，可以接受；若目标是接近成熟 Agent 的 Bash 能力，则最终仍需要真正的 Bash/POSIX parser，而不是继续扩大字符扫描器。

#### 4.1.3 Claude Code 的结构边界

Claude Code 本地源码 `D:\projects\Agents\claude-code-analysis\src\utils\powershell\parser.ts` 同样调用 PowerShell 原生 AST，但它保留的领域结构更丰富：

- `ParsedPowerShellCommand`：语法有效性、错误、顶层 statements、变量、`--%`、type literals、using/script requirement 等；
- `ParsedStatement`：statement 类型、完整文本、pipeline commands、nested commands、重定向和 statement 级安全模式；
- `ParsedCommandElement`：命令名、`cmdlet/application/unknown` 类型、参数、元素类型、参数子节点和重定向；
- `ParsedVariable`：变量 path 与 splatting 信息。

Claude Code 也派生 `hasScriptBlocks`、`hasAssignments` 等安全标志，但这些标志来自保留下来的 AST 结构，是供后续校验使用的视图，而不是结构结果本身。需要特别注意：这一事实只能证明 Claude Code 为后续判断保留了证据，不能单凭 parser 推出其最终一定放行某种语法；最终体验还取决于后面的只读校验、权限规则和执行模式。

#### 4.1.4 落实后的结构层职责

本次没有先抽象跨 Shell 的统一树，而是为 PowerShell 增加专属 `PowerShellProgramSyntax` 投影，直接保留：

- statements、父 statement、statement 类型与 source range；
- statement 的直接命令和嵌套命令；
- pipeline 元素类型和命令顺序；
- 每个 CommandElement 的原生 AST 类型、文本、常量值及参数直接子节点；
- 变量引用、splatting、.NET 类型字面量；
- statement 局部安全结构、重定向、using statement 和 script requirement 证据。

现有 `ShellCommandSyntaxNode[]` 暂时保留为兼容视图，但由 `PowerShellProgramSyntax` 派生，不再是原生 parser 的主输出。复杂 PowerShell 成功解析后，通用字符扫描器只保留 hardline 快速拦截和 parser 失败降级职责，不再决定结构或能力开关结论。

Bash/POSIX 继续沿用现有路径。本项目应在 Bash 也形成稳定的 Shell 专属解析结构后，再根据两条真实链路抽取确实重复的上层接口，避免提前设计大一统 IR。

#### 4.1.5 原子验收标准

结构解析层完成的标准不是“真实 C 盘命令被 allow”，而是以下结构事实全部正确：

| 输入结构 | 必须保留的事实 | 本层不应作出的结论 |
|---|---|---|
| `Get-Content a | Select-String x` | 两个 command、一个 pipeline、顺序与 source range | 管道是否安全 |
| `ForEach-Object { $x = Get-Item $_; $x.Length }` | 外层命令、脚本块 body、局部赋值、嵌套命令、属性访问 | 赋值是否允许 |
| `if ($size -gt 0) { Get-Item $path }` | 条件表达式、then body、内部命令归属 | `if` 是否危险 |
| `[math]::Round($size/1GB, 2)` | 静态类型、method、参数表达式 | 该方法是否纯函数 |
| `$_.Delete()` | receiver 与 method 名 | 是否写入 |
| `Get-Content x > out.txt` | 命令、重定向类型、目标表达式 | 是否需要审批 |
| `cmd /c "..."` 或 `pwsh -Command "..."` | 嵌套 Shell 边界与内部 payload | 是否递归放行 |

#### 4.1.6 本项结论

1. PowerShell 不应回退到字符级结构猜测；原生 AST 应成为成功解析后的唯一结构事实。
2. `ShellCommandSyntaxNode[]` 仅作为兼容视图；后续 PowerShell 表达式、资源和权限模块应消费 `PowerShellProgramSyntax`。
3. Bash 与 PowerShell 不共享 parser；跨 Shell 公共表示推迟到两条专属链路稳定之后再抽取。
4. 本次只解决结构证据丢失，不改变脚本块、赋值或成员调用的权限结论，因此 Claude Code 参考命令目前仍可能是 `ask`。
5. 下一原子问题应基于已保留的逐 statement 和逐参数证据处理原子命令语义，不能重新退回字符串前缀或全局布尔值。

### 4.2 原子命令语义

**状态：已完成第一轮分析与代表性能力实现**

> 2026-07-16 实施说明：本项已经新增 `AtomicCommandEvidence`、分 Shell 能力目录、参数级验证器和资源 operand 候选，并接入现有复合命令分析。为避免在资源分析与统一权限策略完成前产生安全回退，旧 `sideEffect/permission` 暂时由独立兼容投影从 evidence 派生；该投影不是原子语义层的长期职责。

#### 4.2.1 MyAgent 当前做法

`atomic-command-analyzer.ts` 当前同时完成五件事：

1. 使用轻量 tokenizer 提取 executable 和 arguments；
2. 通过字符串前缀匹配 `READONLY_COMMANDS`；
3. 通过 executable 精确匹配 `WRITE_COMMANDS`；
4. 对少数内容读取命令匹配敏感路径正则；
5. 直接返回 `sideEffect`、`permission`、原因和授权规则建议。

这种实现对于阶段性原型很直接，但它把“命令是什么”“命令可能做什么”“访问什么资源”“当前策略是否允许”压进了一个函数。随着复合命令开放，任何一层信息不足都会统一表现成“无法静态证明命令副作用”。

#### 4.2.2 已确认的问题

**问题一：字符串前缀不能代表命令语义。**

当前只读规则使用“完整相等或以规则加空格开头”。这无法处理参数改变行为的情况，例如：

- `find . -type f` 只读取目录，但 `find . -exec rm {} ...` 会执行写命令；
- `git log` 通常只读，但部分输出参数可以写文件；
- `npm test`、`npm run test` 和 `vitest` 会执行项目代码，测试代码可以产生任意副作用，不能归为确定只读；
- PowerShell 同名 token 可能是 cmdlet、alias、函数、脚本或 application，单靠文本 `Get-Content` 无法证明实际调用的是内置 cmdlet。

因此，“命令名 + 任意后缀参数”不是可靠的只读规则。

**问题二：只读与写入不是完整的行为维度。**

单一的 `read < sensitive-read < write < unknown < hardline` 排序会丢失组合行为。实际命令可能同时涉及：

- 文件系统读取或写入；
- 进程启动、终止或后台运行；
- 网络访问；
- Shell 会话状态变更；
- 凭据、环境变量或剪贴板等敏感信息暴露；
- 动态代码加载或执行；
- 纯内存转换和标准输出。

例如 `Invoke-WebRequest` 可能只写标准输出但发起网络请求；`Set-Location` 不写文件却改变后续相对路径语义；`npm test` 的静态命令名不能约束其执行代码。把这些压成一个最高等级，不利于资源分析和策略组合。

**问题三：敏感路径判断放错了层。**

`isSensitiveRead()` 只为少数读取命令寻找第一个非 `-` 参数，并匹配字符串正则。它无法可靠处理：

- PowerShell `-Path` / `-LiteralPath` 参数绑定；
- 多路径、数组、通配符和 pipeline 输入；
- 相对路径与 cwd；
- 变量和表达式生成的动态路径；
- provider path、符号链接和先 `Set-Location` 后读取。

原子命令层可以声明“哪些参数承载资源”，但不应在这里完成路径解析和敏感性决策。

**问题四：命令身份没有成为一等证据。**

当前 `normalizeExecutable()` 会去掉路径和 `.exe`，这会把 `scripts\Get-Content.ps1`、`Get-Content.exe` 与 PowerShell 内置 `Get-Content` 向同一名称压缩。成熟判定必须保留原始调用形式，并区分至少：

- Shell builtin / keyword；
- PowerShell cmdlet；
- alias；
- function；
- script；
- native application；
- 动态或未知命令名。

**问题五：命令表缺少参数级约束和专用验证器。**

有些命令的全部参数面都只读，有些只有特定 flag 或 subcommand 只读，还有些需要额外语义检查。单纯维护 `READONLY_COMMANDS` 和 `WRITE_COMMANDS` 两张名称表无法表达这些差异。

#### 4.2.3 Claude Code 的对应边界

Claude Code 的 PowerShell 只读校验并非简单的 cmdlet 名称集合。其本地源码体现了以下层次：

1. parser 为命令提供 `cmdlet/application/unknown` 的 `nameType`；
2. alias 先解析到规范 cmdlet，但会避免与原生 executable 冲突的别名；
3. `CMDLET_ALLOWLIST` 为每个 cmdlet 配置安全 flags、是否允许全部 flags，以及附加危险检查回调；
4. `git`、`gh`、`docker`、`dotnet` 等外部程序按安全 subcommand 和 flags 单独验证；
5. 某些表面只读的 cmdlet因模块自动加载、网络访问、敏感值泄露或动态参数而被移出自动放行集合；
6. 输出/转换 cmdlet也会检查参数 AST 类型，而不是只看名称。

这套实现说明“能力目录 + 参数验证器”是必要边界。不过它包含大量 Claude Code 自身威胁模型和历史安全修复，MyAgent 不应机械复制全部规则；应复用其分层思路，并根据通用 Agent 的资源与权限模型选择规则。

Claude Code 实际回答中出现的 `ForEach-Object`、计算属性和局部赋值不能在本项直接得出结论：`ForEach-Object` 是高阶容器，其行为取决于脚本块，属于第 3、4 项。

#### 4.2.4 推荐的原子语义输出

推荐将当前“名称数组”替换为分 Shell 的命令能力注册表。原子命令分析只输出行为证据，不输出最终权限：

```text
AtomicCommandEvidence
  identity
    rawName
    canonicalName
    kind: builtin | cmdlet | alias | function | script | application | unknown
    resolutionConfidence
  arguments
    typedArguments[]
    matchedSubcommand
    validatedFlags[]
    unknownFlags[]
  possibleEffects[]
    filesystemRead | filesystemWrite
    processStart | processControl
    network
    sessionMutation
    codeExecution
    sensitiveDisclosure
    pureTransform
    unknown
  resourceOperands[]
    参数位置或参数名、访问类型、静态/动态状态
  evidenceReason
```

能力注册项应支持：

- 精确 canonical identity；
- 安全 subcommand；
- 安全/危险 flag；
- 参数位置和命名参数规则；
- 可选专用验证函数；
- 产生的 effect 集合；
- 资源参数描述；
- Shell 版本或平台条件。

未知第三方命令不需要猜测为写操作，但必须保留 `unknown`/`codeExecution` 证据，交给沙盒、用户规则或权限策略决定。

#### 4.2.4.1 第一轮实现结果

本轮已经落实：

- `AtomicCommandIdentity`：保留原始名称、canonical 名称、静态身份类型和解析可信度；PowerShell 安全别名先映射到 canonical cmdlet，路径、`.ps1` 和 `.exe` 不再与同名 cmdlet 混淆；
- `AtomicArgumentEvidence` 与 `AtomicCommandValidation`：记录参数角色、PowerShell AST 类型、动态状态、安全子命令、已验证标志和未知标志；
- `AtomicCommandEffect[]`：允许同时表达文件读取/写入、系统读取、进程启动、网络、会话变化、代码执行、纯转换和未知行为；
- `AtomicResourceOperand[]`：只声明参数中的资源候选、访问方式和动态状态，不在本层规范化路径或决定敏感性；
- 分 Shell 代表性能力目录：覆盖现有常用读取、展示、写入命令，并为 `git`、`find`、`Invoke-WebRequest` 增加专用验证器；
- PowerShell AST 参数接入：`ArrayLiteralAst` 和可展开字符串保留直接子表达式，静态属性数组不会被误判为动态，含变量的参数仍保留 `unknown`；
- 执行器类命令校正：`npm test`、`vitest`、`node`、`npx` 等输出 `processStart + codeExecution`，不再因为名称像测试命令而声明为确定只读。

第一轮没有复制 Claude Code 的完整历史规则表，也没有声称完成运行时命令解析。当前 `cmdlet/application/alias/script` 主要是静态身份；函数遮蔽、运行时 alias、模块自动加载和第三方命令实际能力仍保守保留不确定性。后续扩充规则时应由失败样例和真实使用场景驱动，而不是无边界搬运名单。

#### 4.2.5 与其它模块的边界

本项负责：

- 识别命令身份；
- 根据静态参数确定命令自身可能产生的 effect；
- 声明资源参数的位置和访问类型；
- 对无法证明的参数保留不确定性。

本项不负责：

- 执行脚本块内部语义；
- 解析和归一化实际路径；
- 判断路径是否敏感或是否在工作区外；
- 应用用户 allow/ask/deny 规则；
- 生成审批决定。

#### 4.2.6 原子验收矩阵

| 输入 | 预期原子语义证据 | 不能仅凭本项得出的结论 |
|---|---|---|
| `Get-ChildItem -Path C:\ -File` | cmdlet、filesystemRead、资源参数 `-Path` | C 盘是否允许读取 |
| `scripts\Get-ChildItem.ps1` | script/application、codeExecution | 因名称相同而视为 cmdlet |
| `find . -type f` | application、filesystemRead、静态路径 | 最终 allow |
| `find . -exec rm ...` | application、codeExecution，并暴露嵌套执行参数 | 仍归为只读 |
| `git status` | application、安全只读 subcommand | 仓库路径是否允许 |
| `git log --output=x` | filesystemWrite 或无法证明安全的 flag | 仍归为只读 |
| `npm test` | application、codeExecution、effect 不可静态封闭 | 因名称含 test 而归为 read |
| `Remove-Item x` | cmdlet、filesystemWrite、资源参数 | 当前模式是否 ask |

#### 4.2.7 本项结论

1. 当前 `READONLY_COMMANDS` 前缀匹配不能作为长期原子语义模型。
2. 原子命令分析必须从“名称白名单”升级为“规范身份 + 参数约束 + effect 集合 + 资源参数描述”。
3. `sideEffect` 与 `permission` 已从新的 evidence 契约中解耦；现有字段仅由兼容投影保留，待资源分析和统一权限策略接管后删除。
4. Claude Code 值得复用的是分层能力目录和参数验证机制，不是照搬全部安全名单。
5. 结构层已经提供逐命令和 typed argument 证据；运行时命令解析仍未实现，因此身份可信度必须继续显式保留。

### 4.3 表达式与脚本块语义

**状态：已完成第一轮分析与有限语义实现**

> 2026-07-16 实施说明：官方 PowerShell AST 现在会投影赋值、变量、成员访问/调用、运算、类型、脚本块、条件和循环等语义节点；独立表达式分析器按 statement 生成 `PowerShellExpressionEffectSummary`。本项只增加证据，现有动态结构仍保持 `ask`，待第 4 项完成嵌套聚合后再调整最终权限表现。

#### 4.3.1 为什么不能继续使用全局布尔标志

MyAgent 当前把 PowerShell AST 归纳为 `hasScriptBlocks`、`hasSubExpressions`、`hasMemberInvocations`、`hasAssignments`、`hasControlFlow` 等全局标志，并在 `describeDynamicStructure()` 中统一转为“无法自动证明为只读”。

这种做法能够防止危险脚本块被误放行，但无法区分以下明显不同的行为：

```powershell
$size = (Get-ChildItem C:\ -File | Measure-Object Length -Sum).Sum
$env:PATH = 'C:\attacker;' + $env:PATH
$object.Name = 'changed'
[math]::Round($size / 1GB, 2)
[System.IO.File]::Delete('C:\data.txt')
$_.Delete()
```

这些语句分别涉及局部数据绑定、执行环境变化、对象 setter、纯计算、明确文件写入和动态对象方法调用。仅凭“有赋值/成员调用”无法形成有意义的行为结论。

#### 4.3.2 MyAgent 运行时对表达式语义的影响

`terminal-engine.ts` 每次执行都会创建新的 Shell 子进程，且 `shell: false`，具体 Shell 由 `terminal-plan.ts` 显式解析。因此，PowerShell 普通局部变量和普通 `global:` scope 只存在于本次子进程，不会跨工具调用持久化。

但“子进程临时状态”不等于没有影响：

- `$env:*` 赋值会改变本次命令后续子进程的环境和命令解析；
- `Set-Location` 会改变同一复合命令中后续相对路径的解析；
- 对象属性 setter 和方法调用可以写文件、改注册表、启动进程或访问网络；
- 静态类型初始化、类型转换和自定义 property getter 也可能执行用户代码；
- 无限循环或高成本表达式会消耗运行时间和系统资源；
- 读取 `$env:*`、凭据对象等值并输出，会形成敏感信息暴露。

因此表达式层仍需建模“本次执行内的会话变化”“外部持久副作用”“信息流”和“终止性风险”。

#### 4.3.3 Claude Code 证据及其限制

Claude Code 本地源码中的 `isReadOnlyCommand()` 对 script block、subexpression、expandable string、splatting、member invocation 和 assignment 统一 fail-closed；`isProvablySafeStatement()` 也只认可全部元素都是 `CommandAst` 的普通 `PipelineAst`。

这套策略的优点是边界清楚、安全保守，缺点是无法自动认可复杂但正常的 PowerShell 数据处理。用户提供的 Claude Code 实际回答却执行了局部赋值、`if`、计算属性和 `[math]::Round()`。两者存在表面差异，可能来自：

- Claude Code 版本差异；
- 权限模式或用户已有 allow 规则；
- 参考会话中的 PowerShell 工具走了不同自动授权路径；
- 本地源码快照比实际运行版本更保守。

在没有完整运行配置证据前，不能断言 Claude Code 是通过表达式静态证明放行了这些命令。可以确定的是：良好体验要求系统最终能够顺畅执行这些调查命令；MyAgent 是否通过更强静态分析、显式规则、沙盒或模式策略实现，需要在后续权限项统一决定。

#### 4.3.4 推荐的表达式分析模型

不建议尝试证明完整 PowerShell 语言安全。推荐实现“可递归证明的有限子集”，其余表达式返回明确的 `unknown` 证据。

建议输出：

```text
ExpressionEffectSummary
  effects[]
  readsVariables[]
  writesVariables[]
  resourceExpressions[]
  dataSensitivity
  termination: bounded | potentially-unbounded | unknown
  confidence: proven | conditional | unknown
  childSummaries[]
```

第一批可证明子集：

1. 字面量、数组/哈希表字面量：聚合所有元素表达式的 effect；
2. 算术、比较、逻辑和字符串组合：聚合左右操作数，不额外产生外部 effect；
3. 普通局部变量绑定：记录本次调用内的 local mutation，外部 effect 继承自右值；
4. `if`：分析条件，并合并所有可能分支的 effect；
5. `$()`、括号表达式：递归分析内部 statement；
6. `[PSCustomObject]@{ ... }`：在所有字段表达式可证明时视为内存投影；
7. 明确登记的纯函数：例如 `System.Math` 的纯数值方法，按类型与 method 的组合注册，而不是为某条命令文本加特例；
8. 属性读取：保留 receiver 类型证据；只有已知数据对象/属性才能证明为纯读取，未知自定义 getter 保留不确定性。

必须保守处理的首批边界：

1. `& $command`、`Invoke-Expression` 等动态执行；
2. 未登记的静态或实例方法调用；
3. 对象属性、静态属性、provider path 赋值；
4. `$env:` 等会影响后续执行环境的赋值；
5. splatting 和动态参数绑定；
6. 自定义类型构造、类型转换和可能触发初始化代码的 type literal；
7. loop、递归 function 和无法证明有界的枚举；
8. trap、try/finally、event、job、runspace 等改变控制或并发执行的结构。

#### 4.3.4.1 第一轮实现结果

本轮已经落实：

- `PowerShellSemanticNodeSyntax`：保留语义节点类型、source range、父节点、所属 statement、运算符、变量、赋值左值、成员 receiver、静态类型和方法名；
- `PowerShellExpressionEffectSummary`：按 statement 输出 effects、变量读写、资源表达式、数据敏感度、终止性、可信度和稳定原因；
- 普通局部变量赋值输出 `localMutation`，不会再与 `$env:`、`global:`、`script:` 等会话修改混为一类；
- `[math]` / `[System.Math]` 静态方法作为登记的纯数值计算输出 `pureTransform`；
- `[System.IO.File]` 的首批读写方法输出 `filesystemRead` / `filesystemWrite`，并保留完整资源表达式供后续路径层解析；
- 未登记的实例/静态方法和对象 setter 输出 `unknown`，不会因为方法名看似安全而自动证明；
- loop 输出 `potentially-unbounded + unknown`；
- `ForEach-Object { ... }` 内部的局部绑定、属性读取和纯数学调用能够按各自 statement 保留下来，供下一项自底向上聚合。

本轮尚未实现完整数据流图。当前可以列出变量读写并区分环境变量敏感源，但还不能把 `$folder = $_`、`$path = $folder.FullName` 还原为可供路径层直接使用的来源链。属性读取也只标记为 `conditional`，不会假定未知对象 getter 一定纯净。`if` 的条件与分支节点已经保留，分支 effect 并集属于第 4 项。

#### 4.3.5 需要最小数据流，而不是只有副作用

表达式层至少需要在单条命令内跟踪简单变量来源：

```powershell
$folder = $_
$path = $folder.FullName
Get-ChildItem -Path $path
```

若只看到最后的 `$path`，资源分析会认为路径完全动态；若保留局部赋值链，则可以把它描述为“来自上游对象的 FullName”，交给资源层继续判断。

同样，以下两条在外部状态上都可能没有写入，但信息安全含义不同：

```powershell
Write-Output $size
Write-Output $env:API_KEY
```

因此变量证据至少需要区分：字面量、上游 pipeline 对象、文件/系统读取结果、环境变量、凭据/敏感源和未知源。

#### 4.3.6 原子验收矩阵

| 表达式 | 预期表达式证据 |
|---|---|
| `$size = 10` | local mutation、bounded、proven |
| `$size = (Get-Item x).Length` | local mutation + 继承内部命令读取；属性纯度有条件 |
| `$env:PATH = 'x'` | session/environment mutation |
| `$object.Name = 'x'` | setter invocation / unknown external effect |
| `[math]::Round($size, 2)` | 已登记纯函数 + 参数 effect |
| `[IO.File]::Delete($path)` | filesystemWrite |
| `$_.Delete()` | 未知 receiver 的 member invocation，至少 unknown/write-capable |
| `[PSCustomObject]@{Name=$x}` | 内存投影 + `$x` 的数据敏感度 |
| `if ($x) { Get-Item a } else { Remove-Item b }` | 条件 + 两分支 effect 并集 |
| `while ($true) { Get-Process }` | potentially-unbounded，即使 body 只读也不是普通纯读取 |

#### 4.3.7 本项结论

1. 脚本块、赋值、成员调用和控制流只能作为“需要递归分析”的结构证据，不能直接等同于写操作。
2. MyAgent 适合实现有限、可证明的 PowerShell 表达式子集，不适合尝试完整语言静态验证。
3. 局部赋值因单次子进程模型通常不会持久化，但仍需保留数据流和本次执行内状态变化。
4. 成员访问必须结合 receiver/type/method；`[math]::Round()` 与 `$_.Delete()` 不能共享同一风险结论。
5. 表达式分析输出 effect 与不确定性，不直接输出权限。

### 4.4 嵌套行为聚合

**状态：已完成第一轮实现**

#### 4.4.1 当前聚合模型的局限

MyAgent 当前将所有子命令映射成 `CommandSegmentAnalysis[]`，再按固定等级取最大 `sideEffect`，权限按 `deny > ask > allow` 取最大。这个模型适合简单的独立命令序列，但不能表达：

- statement 的执行先后会改变后续命令环境；
- 条件分支并非所有节点都会执行；
- pipeline 除了执行顺序，还有对象/文本数据流；
- `ForEach-Object`、`Where-Object`、计算属性等高阶结构会重复执行脚本块；
- background 会让 effect 生命周期超出当前前台等待；
- 重定向是对命令输出的附加资源操作；
- 嵌套 Shell 会重新解释一段字符串，形成新的解析边界。

更直接的问题是：`ForEach-Object` 自身不在只读命令表时会产生 `unknown`，即使内部 body 全部可证明为读取，`max()` 仍会把整体固定为 unknown。反过来，若未来把 `ForEach-Object` 名称直接加入只读表，又可能漏掉 `{ $_.Delete() }`。这说明高阶命令不能在原子层独立定性。

#### 4.4.2 不同组合结构需要不同聚合算子

推荐按 AST 结构定义 effect algebra：

1. **顺序 `;` / newline**：effect 取并集，并将前一 statement 的 session/resource state 传给后一 statement；
2. **pipeline `|` / `|&`**：effect 取并集，同时建立上游输出到下游输入的数据流；
3. **条件链 `&&` / `||`**：保留条件执行关系，最终 possible effects 是分支并集，但解释中应指出哪些 effect 只在失败/成功分支出现；
4. **`if/switch`**：条件 effect 加所有可达分支 effect；静态条件可缩小分支，否则保留并集；
5. **高阶脚本块**：容器本身的 effect 加 body effect，并标记 body 可能按输入元素重复执行；
6. **subexpression / calculated property**：递归继承内部 summary，并将结果作为父表达式的数据值；
7. **redirection**：在被重定向节点上附加资源读写 effect，不能作为独立无上下文 command；
8. **background / job**：增加异步进程 effect、生命周期和取消责任；
9. **nested shell**：解析器可识别 launcher 和静态 payload 时递归分析；无法可靠提取 payload 时保留 codeExecution/unknown。

#### 4.4.3 聚合必须传播状态，而不只是合并标签

以下命令的风险不来自任一原子命令本身，而来自前后状态依赖：

```powershell
Set-Location $HOME; Get-Content .\.ssh\id_rsa
New-Item link -ItemType SymbolicLink -Target C:\secret; Get-Content .\link
$env:PATH = 'C:\untrusted;' + $env:PATH; tool.exe
```

Claude Code 本地实现专门对 compound 中的 cwd change、symlink creation 和后续读取增加防护，说明成熟实现也必须处理跨 statement 状态。MyAgent 不宜为每种组合继续增加顶层布尔 guard，而应让聚合上下文显式携带：

- effective cwd；
- 环境变量变化；
- 临时 drive/provider 映射；
- 新建或变化的符号链接证据；
- 局部变量的数据来源；
- 后台任务和子进程状态。

无法静态解析状态变化时，后续依赖该状态的资源表达式应标记为动态，而不是错误地按初始 cwd 解析。

#### 4.4.4 推荐的聚合结果

```text
ExecutionEffectSummary
  definiteEffects[]
  possibleEffects[]
  resourceAccesses[]
  stateTransitions[]
  dataFlows[]
  asyncExecutions[]
  termination
  uncertaintyReasons[]
  childSummaries[]
```

`definiteEffects` 与 `possibleEffects` 分开很重要。例如 `Test-Path x && Remove-Item x` 中读取一定发生，删除只在条件成功时发生；权限层仍可以根据 possible write 要求审批，但日志不应声称删除必然发生。

#### 4.4.5 避免重复计算嵌套命令

结构遍历必须以树为事实源：

- 顶层 statement 只聚合其直接 child；
- 脚本块 body 由容器节点引用，不再作为并列顶层 segment；
- 同一个 CommandAst 只能拥有一个稳定 node identity；
- 扁平索引只作为日志视图，不能作为聚合关系；
- 解释结果应能从父节点追溯到触发 effect 的具体后代。

否则 `FindAll(CommandAst)` 的扁平结果会让一个嵌套命令既作为 body effect 又作为顶层子命令参与聚合，造成重复提示和错误的连接关系。

#### 4.4.6 原子验收矩阵

| 输入 | 聚合要求 |
|---|---|
| `Get-Item a; Get-Item b` | 两次读取，顺序执行，无状态变化 |
| `Test-Path a && Remove-Item a` | definite read + possible write，保留条件关系 |
| `Get-ChildItem | ForEach-Object { $_.Length }` | 上游读取 + body 属性读取，body 重复执行 |
| `Get-ChildItem | ForEach-Object { $_.Delete() }` | 上游读取 + possible write/member invocation |
| `Set-Location ~; Get-Content .\.ssh\id_rsa` | cwd transition 影响后续资源解析 |
| `Get-Content x > out.txt` | filesystemRead + filesystemWrite，重定向归属于同一 statement |
| `Start-Job { Remove-Item x }` | async code execution + body write + 生命周期证据 |
| `pwsh -Command $payload` | dynamic nested execution，不能把 launcher 名称当作全部语义 |

#### 4.4.7 本项结论

1. `max(sideEffect)` 不能作为长期复合命令语义模型，应改为 effect 集合、分支可能性和状态传播。
2. `ForEach-Object` 等高阶命令的行为由容器能力与脚本块 summary 共同决定，不能在名称表中固定为 read 或 unknown。
3. cwd、环境、符号链接等跨 statement 状态必须进入聚合上下文。
4. AST 树是聚合事实源，扁平 subcommands 只能作为展示和规则匹配视图。
5. 本项输出执行摘要；兼容层仅把已证明的 effect 投影回现有 `sideEffect/permission`，最终资源范围与策略判定仍由后续层负责。

#### 4.4.8 第一轮实现结果与边界

已新增 `ExecutionEffectSummary` 和 PowerShell statement 树聚合器。每个扁平命令只按 `statementIndex` 归属一次，父节点递归合并直接 child，输出 `definiteEffects`、`possibleEffects`、资源访问、状态迁移、数据流、异步执行、终止性和不确定原因。权限兼容投影因此不再直接对 `CommandSegmentAnalysis[]` 做最大值聚合。

第一轮已经验证：

- `ForEach-Object { $_.Length }`、只读计算属性和字面量表达式管道可被证明为只读并自动放行；
- `ForEach-Object { $_.Delete() }` 等未登记成员调用仍保留 `unknown/ask`；
- `if/switch` child 的行为进入 `possibleEffects`，不会被错误描述为无条件执行；
- 环境变量赋值、`Set-Location` 和后台节点会进入状态迁移或异步证据；
- splatting、动态命令名、停止解析标记、`using` 和 script requirements 仍保守进入不确定原因。

当前实现有意没有提前解决后续原子问题：状态迁移尚未用于重写后续相对路径，资源表达式尚未完成静态求值，nested shell payload 尚未递归解析，异步生命周期也只记录证据。因此这些结构仍可能要求审批，应在 4.5 资源与路径分析及后续策略层继续收敛。

### 4.5 资源与路径分析

**状态：已完成第一轮实现**

#### 4.5.1 当前运行边界

`terminal.ts::createPermissionEvidence()` 当前把 Shell 分析结果投影为核心权限证据时固定设置：

```ts
resources: []
```

因此权限层只能看到整体 `sideEffect`、parseStatus 和子命令摘要，无法知道终端命令实际访问了哪些文件、目录、网络地址、进程或环境变量。

`terminal-guard.ts::validateCwd()` 会把进程启动 cwd 限制在授权工作区内，并解析物理路径防止 cwd 自身通过符号链接逃逸。但这不构成命令沙盒：

```powershell
Get-ChildItem C:\
Get-Content C:\Users\name\.ssh\id_rsa
Remove-Item D:\outside\file.txt
```

这些命令仍可从工作区 cwd 访问外部路径。当前 `detectAdvisoryWarnings()` 会对部分绝对路径生成警告，但它是字符串启发式提示，不是权限资源证据，也不能覆盖命名参数、变量、多路径和嵌套结构。

这个边界符合“当前未启用 OS 沙盒”的事实，但不满足细粒度权限决策需要。

#### 4.5.2 行为与资源必须正交

以下问题必须分别回答：

1. `Get-ChildItem` 是读取还是写入？——行为语义；
2. 它读取 `D:\projects\MyAgent`、`C:\` 还是 `.ssh`？——资源语义；
3. 当前模式是否允许这次读取？——权限策略。

不能因为路径在工作区外就把命令行为改成 `unknown/write`，也不能因为命令本身只读就忽略资源范围。对于通用 Agent，项目外访问是正常能力之一；是否询问取决于用户规则、敏感度、运行模式和未来沙盒配置，而不是解析器硬编码。

#### 4.5.3 资源提取需要命令能力元数据

通用字符串规则“取第一个非 flag 参数”无法可靠提取资源。资源层应消费第 2 项命令注册表提供的参数描述，例如：

```text
Get-ChildItem
  -Path / position 0       -> filesystem read
  -LiteralPath             -> filesystem read

Remove-Item
  -Path / position 0       -> filesystem write/delete

git -C <path> status
  -C                       -> working tree context

Invoke-WebRequest
  -Uri / position 0        -> network request
  -OutFile                 -> filesystem write
```

表达式层再提供参数值是静态字符串、局部变量、上游属性、动态表达式还是未知，资源层据此决定解析精度。

#### 4.5.4 推荐的资源证据

```text
ResourceAccessEvidence
  kind: file | directory | process | network | environment | registry | service | unknown
  operation: read | write | create | delete | execute | connect | mutate
  rawExpression
  resolvedResource?
  baseContext
  scope: workspace | external | sensitive | system | unknown
  certainty: exact | pattern | symbolic | unknown
  sourceNodeId
  reason
```

资源证据应允许一条命令产生多个访问项，也应允许只知道 pattern 而不知道最终单一路径，例如 `C:\Users\*\AppData`。

#### 4.5.5 Windows 与 Shell 路径语义

Windows 路径不能只调用一次 `path.resolve()`：

- 绝对盘符路径、盘符相对路径和 UNC 路径语义不同；
- PowerShell provider path 不一定是文件系统，如 `HKLM:`、`Env:`、`Cert:`；
- 路径大小写通常不敏感，但 provider 可能有不同规则；
- 通配符与 `LiteralPath` 语义不同；
- 已存在路径应考虑 symlink/junction 的物理目标；
- 尚不存在的写目标无法直接 realpath，应验证最近存在祖先并保留剩余路径；
- Alternate Data Stream、设备路径和特殊前缀需要独立处理；
- 复合命令中的 cwd、PSDrive 和环境变化会改变后续解析上下文。

资源层应按 Shell 和 provider 解析，不应让通用 Node path 规则独自承担所有语义。

#### 4.5.6 Claude Code 的可借鉴点

Claude Code 的 PowerShell 路径校验使用 `CMDLET_PATH_CONFIG` 描述不同 cmdlet 的路径参数，再由 path constraint 检查工作目录、显式规则和动态参数；它还针对 compound cwd change、符号链接创建和后续读取做上下文防护。

值得借鉴的是“命令能力描述资源参数，再统一做路径约束”，而不是其具体的工作区默认策略。MyAgent 是通用 Agent，不能默认把 Claude Code 面向编码工作区的全部路径限制照搬过来。

#### 4.5.7 动态资源的降级方式

资源无法精确解析时，不应伪造一个路径，也不应把整个命令结构标记为 invalid。应保留不同层次：

- exact：`Get-Content C:\a.txt`；
- pattern：`Get-ChildItem C:\Users\*`；
- symbolic：`Get-Content $folder.FullName`，且 `$folder` 来源可追踪；
- unknown：`Get-Content (Invoke-Expression $x)`。

后续策略可以对“已知只读 + unknown resource”和“未知行为 + unknown resource”做不同处理。

#### 4.5.8 原子验收矩阵

| 输入 | 资源证据 |
|---|---|
| `Get-ChildItem -Path C:\ -File` | directory read、`C:\`、external/system、exact |
| `Get-Content .\package.json` | file read、按 effective cwd 解析、workspace、exact |
| `Get-Content -LiteralPath $path` | file read、symbolic/unknown，附变量来源 |
| `Remove-Item D:\x.txt` | file delete、external、exact |
| `Get-Item HKLM:\Software` | registry read，不误当文件路径 |
| `Invoke-WebRequest https://example.com` | network connect/read |
| `Invoke-WebRequest x -OutFile y` | network + file write 两项资源 |
| `Set-Location ~; Get-Content .\.ssh\id_rsa` | 第二项按变化后的 cwd 解析 |
| `Get-ChildItem C:\Users\*` | directory read、pattern，不伪装为单一路径 |

#### 4.5.9 本项结论

1. 当前终端权限证据的 `resources: []` 是细粒度权限缺失的直接原因。
2. `validateCwd()` 只限制启动目录，不是文件访问沙盒；文档、提示和日志必须准确表达这一点。
3. 工作区外访问不是天然错误，资源层只描述事实，策略层决定是否询问。
4. 资源提取必须建立在命令参数元数据和表达式数据流之上。
5. 资源证据应覆盖文件之外的网络、进程、环境、注册表等通用 Agent 能力。

#### 4.5.10 第一轮实现结果与边界

已新增正式的 `ResourceAccessEvidence` 与 `ShellResourceAnalysisContext`。统一分析入口可选消费真实 `cwd`、工作区根和物理路径解析器，再按 subcommand 顺序把原子能力目录产生的 operand 转换为资源事实。`Terminal.checkPermissions()` 已传入与实际执行一致的 cwd，并将结果写入 `ToolPermissionEvidence.resources`，不再固定输出空数组。

第一轮已经验证：

- 相对路径按有效 cwd 解析，区分 `workspace`、`external`、`sensitive` 和 `system`；
- 绝对 Windows 路径、通配 pattern、盘符相对路径和动态表达式保留不同 certainty；
- `HKLM:` 等注册表 provider、`Env:`、网络 URI 和文件资源不会互相误判；
- `Invoke-WebRequest -OutFile` 同时产生 network connect 与 file write 两项资源；
- 无条件顶层 `Set-Location`/`cd` 会更新后续路径基准，条件或嵌套 cwd 变化不会被错误当成确定状态；
- 简单局部字符串赋值可以追踪到动态路径参数，其余变量/成员表达式保留 symbolic 或 unknown；
- copy/move 的源读取与目标写入由原子能力元数据区分；
- 终端注入已有物理路径解析器，精确路径和未存在写目标会展开 symlink/junction 或最近存在祖先，通配 pattern 不伪装为单一路径。

资源范围目前仍是事实证据，不会因为 `external/system` 自动改变 `allow/ask/deny`，该行为属于 4.6 权限策略。当前 provider 只细分注册表和环境变量，PSDrive、Cert、服务、进程目标及复杂变量数据流仍需增量补充；其它工具保留旧资源记录形状，不能在本项中顺带进行全仓资源类型迁移。

### 4.6 权限策略

**状态：已完成第一轮实现**

#### 4.6.1 当前决策链

当前权限链大致为：

```text
Terminal.checkPermissions()
  -> Shell 分析
  -> hardline / invalid / read / sensitive-read / write / unknown
  -> 工具层先返回 allow / ask / deny

ToolPermissionService
  -> 收集全局 deny/ask/allow 规则
  -> 调用工具 checkPermissions
  -> tool deny > rule deny > tool ask > rule ask > tool allow > rule allow
  -> 仅对 ask 做 PermissionMode 后处理
```

这意味着 Shell 分析器、终端工具和统一权限服务都在做权限聚合。类型注释声称“工具不得返回最终决策”，但 `ToolPermissionCheckResult` 与实际服务允许工具返回 `allow/ask/deny`，且工具结果优先于部分用户规则，职责并未真正统一。

#### 4.6.2 已确认的策略问题

**问题一：工具 ask 会压过用户 allow。**

当终端把复杂命令判为 unknown 并返回 `ask` 时，`ToolPermissionService` 在 rule allow 之前选择 tool ask。即使用户已经为同一命令配置 session 或 persistent allow，仍会重复询问。

工具发现的不可绕过 hardline 和解析器完整性失败可以高于 allow；Shell 语法错误由真实 Shell 自己报告，权限分析只应把它作为 unknown evidence，交给显式用户规则、模式或沙盒策略处理。

**问题二：工具 allow 直接绕过模式后处理。**

模式逻辑只处理 ask。终端只要返回 read/allow，就不会再经过 plan/default/auto 的差异化策略。这在“所有模式都允许普通读取”时表现正常，但会阻止未来基于资源范围、敏感度或沙盒状态定义模式差异。

**问题三：规则仍以整条原始 command 字符串为主。**

`extractContentFromArgs()` 对 Bash/PowerShell 直接返回整条 command。规则存储可以做 exact 或 wildcard 匹配，但不知道：

- 哪个子命令命中规则；
- 规则针对的是命令身份、flag 还是资源；
- 一条 allow 规则是否被后续管道或条件分支扩张；
- 路径型规则是否也应作用于终端提取出的资源。

这会导致规则要么过窄、频繁重问，要么使用宽泛 wildcard 后覆盖过多行为。

**问题四：Auto 分类器不消费分析证据。**

当前 `AutoPermissionClassifier` 只按工具名称判断安全工具/写工具，未使用 parse tree、effect、resource、规则命中或不确定性原因。对于 Bash/PowerShell 的复杂命令，它无法提供比工具名更精细的判断，也无法解释为什么某个 unknown 可以自动执行。

**问题五：决策来源通过文案识别。**

`bypassPermissions` 为保留显式 ask，使用 `decisionReason.includes('显式 ask')` 判断来源。文案不应承担策略 provenance；改变提示文字可能改变权限行为。

#### 4.6.3 推荐的单一决策边界

建议保留 Claude 风格的 `allow/ask/deny` 最终模型和现有 PermissionMode，但重排职责：

1. **分析层**：只产生结构、effect、resource 和 uncertainty evidence；
2. **不可绕过安全层**：只处理输入契约失败、解析器完整性失败、明确 hardline 和系统 policy deny；Shell 语法错误不属于安全拒绝；
3. **规则层**：对完整调用、结构化子操作和资源候选执行 deny > ask > allow；
4. **内置基线策略**：在没有显式规则时，根据 evidence 给出默认 behavior；
5. **模式层**：基于结构化 decision provenance 和 evidence 做模式转换；
6. **交互层**：只处理最终 ask，不重新分析命令。

Shell 工具在普通情况下可返回 `passthrough + evidence`；只有真正不可绕过的工具不变量才直接 deny。统一服务成为最终行为的唯一产生者。

#### 4.6.4 推荐决策顺序

```text
input contract / integrity failure
  -> deny

Shell syntax invalid / unparseable
  -> unknown evidence，继续进入规则与模式层

non-bypassable invariant / policy deny
  -> deny

explicit deny rules（完整调用、子操作、资源）
  -> deny

explicit ask rules
  -> ask

explicit allow rules
  -> allow，但不能覆盖上面的 deny/ask/invariant

mode baseline + built-in evidence policy
  -> allow / ask / deny
```

规则匹配应生成多个 candidate，而不是只匹配原始 command：

- 完整工具调用 candidate；
- 每个原子/嵌套命令 candidate；
- canonical command + subcommand/flags candidate；
- 每个资源 access candidate；
- operation category candidate。

最终仍可以使用 `Tool(specifier)` 外部规则语法，但 specifier 的生成和匹配必须基于结构化证据，不能只做原始字符串前缀。

#### 4.6.5 PermissionMode 建议语义

| 模式 | 建议基线 |
|---|---|
| `default` | 已证明的普通读取/纯转换 allow；写入、执行、不确定或敏感资源 ask |
| `acceptEdits` | 在允许资源范围内的文件编辑可 allow；不能自动放行任意终端写入、进程或网络操作 |
| `plan` | 已证明读取和纯转换 allow；写入和状态改变 deny；不确定结构不应伪装成只读 |
| `auto` | 基于完整 evidence 自动决定；无法证明时按交互/headless 策略 ask 或 deny，不能只看工具名 |
| `dontAsk` | 正常 allow 保留，ask 转 deny |
| `bypassPermissions` | 普通 ask 可转 allow；显式 ask、deny 和不可绕过不变量保持原行为 |

Claude Code 参考会话在 Plan 模式下能够直接执行大量只读调查命令，说明 Plan 的目标体验应是“可靠识别后自动读取”，而不是“所有读取仍 ask”。

#### 4.6.6 Decision provenance

最终决策至少应携带：

```text
decisionSource:
  invariant | policyRule | userRule | projectRule | builtInBaseline | mode | classifier
matchedRule?
matchedEvidenceIds[]
overridable: boolean
```

这样 bypass、审批提示、日志和规则建议都可以基于稳定字段工作，不再解析中文原因字符串。

#### 4.6.7 原子验收矩阵

| 场景 | 预期 |
|---|---|
| 已证明普通只读，无规则，default | built-in baseline allow |
| unknown 命令，无规则，default | ask |
| unknown 命令，精确用户 allow | allow，除非命中 invariant/deny/ask |
| 明确 hardline，存在 allow wildcard | deny |
| 资源命中 explicit ask，命令名只读 | ask |
| pipeline 前半允许、后半写入 | 写入子操作使整体 ask/deny，不被前半规则覆盖 |
| plan 中普通读取 | allow |
| plan 中写入 | deny |
| auto 中两个不同 PowerShell 命令 | 根据 evidence 分别判断，而不是都按 `PowerShell` 工具名处理 |
| bypass 中显式 ask | 仍 ask，依据 provenance 而非文案 |

#### 4.6.8 本项结论

1. 当前存在分析器、工具和服务三层权限判断，必须收敛为统一权限服务产生最终 behavior。
2. 工具 ask 不应天然高于用户 allow；只有不可绕过 invariant 和 deny/ask 规则可以阻止 allow。
3. PermissionMode 应消费结构化 evidence，不应只对工具层 ask 做字符串化后处理。
4. 规则模型可保留 `Tool(specifier)` 外形，但匹配 candidate 必须扩展到子操作与资源。
5. Auto 分类器若不消费 evidence，对命令权限优化没有实际价值。

### 4.7 审批与执行生命周期

**状态：已完成核心生命周期修正；完整状态事件流仍待后续实现**

#### 4.7.1 当前时序与已完成修正

当前主链为：

```text
AgentLoop
  -> 传递真实上游 cancellation signal
  -> ToolCallOrchestrator.execute()
     -> BeforeTool plugin pipeline
     -> tool_call_start
     -> ToolRegistry.callTool()
        -> ToolCallGateway 权限分析与审批交互
        -> 获批后运行 preparation（文件锁/备份）
        -> ToolExecutor 在实际调用前创建 execution timeout signal
     -> AfterTool
     -> effect resolution
```

现有代码已经把 `toolTimeoutMs` 的启动位置移动到权限审批之后：`agent-loop.ts` 不再为整个工具调用创建 30 秒 timeout，`ToolExecutor.createAuthorizedExecutionSignal()` 在权限通过后才调用 `AbortSignal.timeout(runtime.timeoutMs)`。因此，用户停留在审批界面的时间原则上不再消耗命令执行预算。

当前实现使用 `ToolLifecycleError.code` 区分策略拒绝、用户拒绝、审批中取消、排队中取消、准备失败、执行超时和执行中取消。编排器不再解析“审批拒绝/权限拒绝”等展示文字，并根据错误携带的 `executionStarted` 结算实际 effect。

#### 4.7.2 本轮已修正的生命周期缺口

**缺口一：上游取消信号实际丢失。**

`agent-loop.ts` 注释写“只保留上游取消信号”，实际却创建：

```ts
const toolCallSignal = new AbortController().signal;
```

这个 signal 没有连接 `options.signal`，也没有任何 controller 引用可用于取消。结果是审批等待不受执行 timeout 限制，但也可能无法响应用户取消、会话关闭或任务终止。正确做法是传递真实上游 cancellation signal，只排除 execution deadline，不排除 cancellation。

实现结果：AgentLoop 现在把 `options.signal` 原样传给编排器；该信号继续传到 Gateway、ApprovalService、CLI 审批界面和文件锁队列。取消会移除 pending/queue 项，不会留下幽灵审批或取消后再次获得锁。

**缺口二：审批拒绝仍通过错误文本识别。**

编排器使用 `errorMsg.startsWith('审批拒绝') || ...` 推断拒绝阶段。错误文案变化、国际化或插件返回不同格式都可能破坏 effect 语义。审批拒绝、取消、超时和策略 deny 应使用 typed outcome/error code。

实现结果：新增 `ToolLifecycleError`，Gateway、ApprovalService、ToolRegistry 和编排器使用稳定 code；测试用不含中文“审批拒绝”的文案验证 effect 仍正确。

**缺口三：`executionStarted` 设置仍偏早。**

当前在 BeforeTool 通过后、文件锁和备份开始前就设置 `executionStarted=true`。如果长时间等待锁、备份失败或在实际 tool invocation 前取消，日志仍可能认为执行已开始。应区分 authorized、queued、preparing 和 process/tool started。

实现结果：删除编排器的提前置位；正常路径读取 Gateway outcome，失败路径读取 typed error 的执行事实。文件锁与备份移动为 Gateway 获批后的 preparation callback，准备失败保持 `executionStarted=false`。

**缺口四：所有等待共用“工具调用”外形。**

审批等待、锁等待、子进程运行、后台进程启动和人机交互是不同生命周期。它们需要不同的 timeout、取消、恢复和 UI 语义，不能全部用一个 Promise 是否完成来判断。

实现结果：人工审批默认不再自动超时，显式审批 timeout 仍受支持；锁等待可取消；执行 timeout 只在 preparation 完成、真实工具即将调用时创建。完整状态事件和后台进程细分仍未实现。

#### 4.7.3 推荐状态机

```text
proposed
  -> analyzing
  -> awaiting_approval
     -> denied
     -> cancelled
     -> authorized
  -> queued
  -> preparing
  -> started
     -> completed
     -> failed
     -> timed_out
     -> cancelled
```

对于 background 工具，`started` 后还应区分 `detached/running` 与最终进程结束；前台工具的 completed 才表示工具结果已返回。

每个状态转换都应记录稳定 code、时间和 correlationId，避免从中文错误文案反推阶段。

#### 4.7.4 推荐计时边界

| 阶段 | 计时策略 |
|---|---|
| 结构/权限分析 | 独立的短 parser/analysis timeout |
| 人工审批 | 不计入 execution timeout；可选产品级 interaction expiry，但默认允许长时间等待 |
| 用户/会话取消 | 全阶段有效，包括审批等待 |
| 锁等待 | 独立 queue timeout 或可取消等待 |
| 备份/准备 | 独立 preparation budget，或纳入执行前阶段明确记录 |
| 实际工具执行 | 从 tool/process 真正启动时计算 `toolTimeoutMs` |
| background 启动 | 只限制启动确认时间，不把进程完整生命周期强塞进前台 timeout |

#### 4.7.5 预测 effect 与实际 effect 分离

权限阶段产生的是 predicted evidence：命令可能读取/写入什么。执行结束后记录的是 actual lifecycle/effect：是否启动、是否完成、哪些资源实际确认发生变化。

建议 actual outcome 至少区分：

- `denied_before_execution`；
- `cancelled_while_awaiting_approval`；
- `cancelled_while_queued`；
- `failed_during_preparation`；
- `execution_timed_out`；
- `execution_failed_after_start`；
- `execution_completed`；
- `background_started`。

用户拒绝审批应作为正常权限结果反馈给模型，而不是伪装成命令运行错误；模型仍需知道请求未执行，以便调整计划。

#### 4.7.6 授权与执行之间的一致性

当前一次性 `AuthorizedExecutionContext` 和 consume 机制是正确方向，可以防止授权凭据被重放。后续还需保证：

- 实际执行参数与获批参数一致，或修改后重新分析；
- tool name、shell kind、cwd 和结构化资源证据绑定到授权上下文；
- 长时间审批后若 cwd/规则/关键资源状态变化，按风险决定是否重校验；
- tail call 获得独立授权与生命周期，不继承父调用的宽泛许可。

#### 4.7.7 原子验收矩阵

| 场景 | 预期生命周期 |
|---|---|
| 用户审批等待 5 分钟后允许，命令运行 2 秒 | approval 不超时；execution timeout 从允许后开始 |
| 审批期间用户取消任务 | cancelled_while_awaiting_approval，未启动 |
| 用户拒绝 | denied_before_execution，不记 execution failure |
| 等待文件锁时取消 | cancelled_while_queued，未启动工具 |
| 进程启动后超过 30 秒 | execution_timed_out，executionStarted=true |
| BeforeTool 修改 command | 重新分析修改后的输入并绑定新授权 |
| background 服务成功启动 | background_started，不等待服务自然退出 |
| tail call 需要写入 | 独立进入权限检查和审批 |

#### 4.7.8 本项结论

1. 执行 timeout 延后到授权后启动的修正是正确的，审批等待不应计入命令超时。
2. 下一步必须恢复真实上游 cancellation，而不是使用永不取消的空 signal。
3. 审批拒绝和执行阶段应使用 typed outcome，不能依赖错误字符串。
4. `executionStarted` 应在实际工具/进程启动时设置，授权、排队和准备是独立状态。
5. 一次性授权上下文应继续保留，并绑定最终执行参数与资源证据。

#### 4.7.9 当前剩余边界

1. 目前已经有稳定 failure code 和 effect，但尚未对 `authorized/queued/preparing/started` 每次转换都发出独立事件和时间戳。
2. background 工具仍未正式区分 `background_started`、`detached` 和最终进程结束。
3. preparation 目前可取消但没有独立时间预算；后续如增加 queue/preparation timeout，应与 `toolTimeoutMs` 分开配置。

### 4.8 模型提示与工具描述

**状态：已完成第一轮实现**

#### 4.8.1 当前描述中的事实偏差

`terminal.ts` 文件头声称“提供受限沙箱隔离”，Shell 工具默认描述为“在工作区内执行一条命令”。但当前真实边界是：

- 进程 cwd 被限制在工作区；
- 命令可通过绝对路径访问工作区外资源；
- 没有 OS 级文件系统或网络沙盒；
- 权限系统只在执行前分析并可能要求审批。

“以工作区为 cwd 启动”与“只能在工作区内操作”含义完全不同。错误描述会让模型产生错误安全假设，也会让用户误判实际保护范围。

#### 4.8.2 当前描述缺少的运行事实

现有 schema 已说明 command、cwd、background 和 watch patterns，但没有准确告诉模型：

- Bash 与 PowerShell 是两个固定语义工具；
- 每次调用启动新的 Shell，变量和函数不会跨调用保存；
- 标准复合语法当前实际支持到什么程度；
- 审批可能发生，但审批等待不属于执行超时；
- background 只适合不需要立即结果的长期任务；
- 输出可能被截断；
- 当前是否启用沙盒，以及沙盒实际覆盖哪些范围。

能力信息不必全部写成长篇规则，但不能让模型靠猜测补齐。

#### 4.8.3 Claude Code 的可借鉴与不宜照搬部分

Claude Code 的 PowerShell tool prompt 会动态包含：

- PowerShell edition 与版本语法差异；
- 工作目录和 Shell state 的持久性；
- background、sleep、交互命令和输出限制；
- PowerShell 对象管道、变量、引号和 here-string 基础；
- 专用文件工具的优先级；
- Git 高风险行为提醒。

可借鉴的是“把 Shell 专属、版本相关和运行时能力放在工具描述，而不是全局人格提示词”。不宜照搬的是完整篇幅和编码 Agent 专属强制规则。MyAgent 是通用 Agent，文件调查、系统诊断等任务本来就可能合理使用 PowerShell；工具描述应提供偏好，而不是无条件禁止。

用户先前已经决定删除全局 `RULE_TOOL_PRIORITY`，当前简短的 `FILE_SEARCH_TOOL_GUIDANCE` 更符合这一方向：当 grepSearch/globSearch 能直接表达需求时优先使用，Shell 有专属语义时仍可使用终端。

#### 4.8.4 推荐的提示分层

**基础系统提示词只保留：**

- Agent 身份、通用工作原则和用户沟通风格；
- 不重复各工具 schema 已经描述的细节；
- 不声明未启用的沙盒或阶段性语法限制。

**Shell 工具描述动态提供：**

- 当前工具的 Shell family；
- cwd 与状态持久性；
- 当前实际启用的复合结构能力；
- background/timeout/output 边界；
- 当前 sandbox 状态及其准确含义；
- 简短的专用工具选择建议。

**权限提示只提供：**

- 哪个行为或资源触发 ask；
- 命令是否尚未启动；
- 用户选择的授权范围和可复用规则；
- 不向模型输出“当前阶段不支持管道”之类已经失效的内部实现文案。

**执行错误只提供：**

- parser error、permission denial、execution timeout、exit code 等真实类别；
- 不把审批等待描述为命令超时；
- 不把权限拒绝描述为命令运行失败。

#### 4.8.5 推荐的最小工具说明方向

不要求立即采用以下文案，但目标信息可以压缩为：

```text
在指定工作目录启动一条 PowerShell/Bash 命令。每次调用使用独立 Shell，
局部变量和函数不会跨调用保留。支持当前已启用的标准复合语法；执行前可能
根据命令行为和访问资源请求授权。cwd 限制启动目录，不代表文件系统沙盒。
长时间服务请使用后台模式。
```

实际装配时应按能力开关删减，而不是无论配置如何都输出同一文本。

#### 4.8.6 模型不应承担的责任

提示词不能替代底层分析：

- 不能要求模型“保证命令只读”后就跳过 AST 分析；
- 不能要求模型为了绕过误判而拆成大量低效命令；
- 不能让模型判断路径是否在沙盒内；
- 不能把系统内部 allowlist 全量暴露给模型并期待其自我约束；
- 不能用“尽量简单”阻止正常的 `ForEach-Object`、管道和计算投影。

模型负责选择合适工具并表达意图，系统负责验证真实调用。

#### 4.8.7 原子验收场景

| 场景 | 预期模型认知 |
|---|---|
| 请求调查 C 盘 | 知道 PowerShell 可读取工作区外资源，但可能触发资源策略 |
| 两次 PowerShell 调用 | 不假设第一次定义的 `$x` 在第二次仍存在 |
| 长时间服务 | 使用 background，而不是用长 sleep 阻塞 |
| 搜索项目文本 | 通常选择 grepSearch；需要 PowerShell 对象语义时可选终端 |
| 未启用沙盒 | 不声称命令只能访问项目文件 |
| 复杂只读命令被 ask | 根据具体风险证据调整，不泛化为“系统不支持复合命令” |
| 用户审批很久 | 不解释为命令执行超时 |

#### 4.8.8 本项结论

1. 当前“受限沙箱隔离”和“在工作区内执行”与真实边界不符，应在后续实现中优先修正。
2. Shell 能力说明应进入各自工具描述，并根据版本、能力和 sandbox 状态动态装配。
3. 不需要复制 Claude Code 的长篇 PowerShell 手册，只保留影响正确调用的运行事实。
4. 提示词不能弥补结构、语义、资源和权限模块的缺口。
5. 权限与执行反馈必须使用准确阶段术语，避免模型据错误文案继续产生幻觉。

#### 4.8.9 本轮实现结果

- 基础系统提示词未包含 Shell、沙盒或阶段性语法限制，保持不变；
- Bash 与 PowerShell 描述改为说明真实 cwd 边界，不再声称命令只能在工作区内操作或存在文件系统沙盒；
- 工具描述明确每次调用使用独立 Shell、变量与函数不跨调用保留，并根据当前复合结构分析能力生成简短说明；
- 工具描述明确执行前可能请求授权，长时间服务应使用 `isBackground`；
- 结构扫描器的风险原因改为描述命令包含的结构及额外确认原因，不再用“当前阶段不支持”或“当前 Shell 暂不支持”误导模型；
- 本轮只修正模型可见事实和反馈术语，不改变命令解析、权限结果或实际执行行为。

### 4.9 可观测性与综合验收

**状态：已完成必要实现；测试重组与迁移 shadow 分析按需后续处理**

#### 4.9.1 当前日志为什么难以定位误判

当前诊断治理会在 operational/audit 中把 `arguments`、`content`、`prompt` 等正文转换成长度和不可逆摘要，只有显式 replay 模式才保留更多正文。这是合理的隐私默认，尤其终端命令可能包含路径、凭据和用户数据。

问题不在于“日志没有完整命令”，而在于没有足够的安全结构元数据替代正文：

- 缺少独立的 command analysis 完成事件；
- 缺少 parser、命令语义、表达式和资源各层的判定摘要；
- permission decision 没有稳定 provenance 与 matched evidence；
- `tool_effect_resolved` 只记录 kind、reason、resourceCount；
- 审批、排队、启动、超时和拒绝没有统一状态转换事件；
- audit 中只有 digest 时，无法把一次误判还原到具体分析层。

因此最新日志只能证明“进入了 BeforeTool/审批”，不能解释是 `ForEach-Object`、赋值、成员调用、路径还是用户规则触发 ask。

#### 4.9.2 推荐的分层事件

所有事件复用同一 sessionId、toolCallId/correlationId 和 analysisId：

```text
command_parse_completed
  shellKind, parserKind, parserVersion, parseStatus
  statementCount, commandCount, expressionCount, unsupportedKinds[]

command_semantics_completed
  identities[], effects[], unknownReasons[]

resource_analysis_completed
  resourceKinds[], operations[], scopes[], certaintyCounts

permission_decision_resolved
  behavior, decisionSource, matchedRuleId?, matchedEvidenceIds[]
  overridable, mode

approval_state_changed
  awaiting | allowed | denied | cancelled | expired

tool_execution_state_changed
  queued | preparing | started | completed | failed | timed_out | cancelled

tool_effect_resolved
  actualEffect, executionStarted, completed, resourceCount, reasonCode
```

operational/audit 默认不需要记录原始命令；可以记录稳定 node id、canonical command name、AST kind 和资源 scope。路径可按策略记录归一化 scope 或摘要，而不是完整敏感路径。replay 模式继续作为显式调试开关。

#### 4.9.3 面向用户和模型的解释

内部事件与用户提示应来自同一 decision explanation，避免两套文案漂移。例如：

```text
需要确认：命令包含一个无法识别 receiver 的 Delete() 方法调用，
可能修改 C:\ 下的文件。命令尚未启动。
```

而不是：

```text
无法静态证明命令副作用（当前阶段不支持管道）。
```

解释至少指出：行为、资源、证据节点、规则/模式和当前生命周期。对普通 allow 不必输出长篇解释，但日志仍保留结构摘要。

#### 4.9.4 测试需要按模块拆分

当前 `command-analysis.test.ts` 同时断言 parser、subcommands、sideEffect、permission 和风险文案，使结构改造与策略改造互相牵连。推荐拆成：

1. `shell-structure-parser.test.ts`：只验证 AST/IR 和 source relation；
2. `atomic-command-semantics.test.ts`：只验证 identity、flags、effect、resource operands；
3. `powershell-expression-semantics.test.ts`：局部赋值、方法、控制流、数据流；
4. `effect-aggregation.test.ts`：sequence、pipeline、conditional、higher-order、state transition；
5. `command-resource-analysis.test.ts`：路径/provider/network/process 资源；
6. `command-permission-policy.test.ts`：规则、mode、provenance、deny/ask/allow；
7. `approval-execution-lifecycle.test.ts`：fake clock、取消、拒绝、timeout 起点；
8. `terminal-tool-description.test.ts`：能力描述与真实配置一致；
9. 集成与对话测试：只保留少量跨层核心场景。

测试 fixture 应包含正常命令与最小危险变体成对出现，防止只优化 false ask 却引入 false allow。

#### 4.9.5 推荐的对照与迁移方式

对于权限相关重构，建议在切换最终行为前提供短期 shadow analysis：

- 旧分析器继续产生实际 decision；
- 新链路只生成 evidence 和候选 decision，不执行；
- 日志比较 parse 差异、ask/allow 差异和无法解释原因；
- 使用已有正常会话和专门的攻击 fixture 评估；
- 达到接受标准后一次切换单一事实源，删除旧双层扫描路径。

shadow 只用于迁移验证，不应成为长期双轨架构。

#### 4.9.6 综合验收指标

建议关注实际质量，而不是追求用例数量：

- 复杂只读调查命令的误询问率；
- 危险变体的误放行率，必须为零或满足明确风险阈值；
- parser unsupported/timeout 比例；
- unknown effect 与 unknown resource 的原因分布；
- 用户审批等待时间与执行时间是否正确分离；
- 重复审批率，尤其已有 session allow 后是否仍询问；
- 每个 ask 是否能追溯到具体 evidence；
- 工作区外普通读取与敏感资源读取是否被正确区分。

#### 4.9.7 最小有意义的对话验收

自动测试覆盖的纯函数细节不需要用户重复手测。最终只保留几条正常对话：

1. “帮我深入分析 C 盘空间占用，自己调查，不要给通用建议。”——验证复杂只读 PowerShell、外部资源和长任务体验；
2. “用 PowerShell 查找 package.json 中包含 scripts 的行。”——验证普通读取管道不会因复合语法误询问；
3. “删除刚才找到的最大临时目录。”——验证从调查读取切换到具体写入时准确 ask；
4. 在 ask 出现后等待超过 `toolTimeoutMs` 再批准——验证审批时间与执行 timeout 分离；
5. 批准 session 规则后重复同一操作——验证规则真正消除重复审批。

#### 4.9.8 本项结论

1. 保持 operational/audit 默认不记录完整命令是正确的，不应为调试直接取消隐私治理。
2. 必须增加不含敏感正文的结构化分析、权限和生命周期事件。
3. 测试应按九个原子模块拆分，避免一个集成测试同时定义所有层的行为。
4. 迁移期可使用短期 shadow analysis，对比稳定后删除旧路径。
5. 最终手动测试只需少量正常对话，重点验证跨层体验而非重复自动测试。

#### 4.9.9 本轮实现结果

- 复用现有结构化 logger，新增 `command_analysis_completed`、`permission_decision_resolved`、`approval_state_changed` 和 `tool_execution_state_changed`；
- 同一次调用使用 `sessionId`、`correlationId` 和派生 `analysisId` 关联分析、权限、审批与执行阶段；
- 命令分析事件只记录 parser/effect、子命令数量、资源种类与范围，不记录原始命令、风险正文或完整资源路径；
- 权限事件直接记录 `decisionSource`、命中规则来源和 evidence id，不从中文提示推测来源；
- 审批记录 `awaiting/allowed/denied/cancelled`，执行记录真实发生的 `preparing/started/completed/failed/timed_out/cancelled`；未真实检测到锁排队时不虚构 `queued`；
- `tool_effect_resolved` 补充 `executionStarted` 与 `completed`，便于与生命周期事件交叉核对；
- 网关契约测试覆盖事件关联、阶段顺序和默认脱敏；最终跨层回归复用现有命令分析、权限与生命周期测试，不为相同语义重复堆测试；
- 九份测试文件重组和 shadow analysis 是迁移治理建议，不是当前运行正确性的前置条件，本轮不实施。

## 5. 最终综合验收场景

以下场景用于所有原子问题分析完成后的端到端验证，不提前用它们反推生产规则：

1. 正常对话要求深入调查 C 盘空间，Agent 能自主生成并执行只读统计命令。
2. 将只读脚本块中的投影表达式替换为 `$_.Delete()` 后，系统能够准确升级权限，而不是继续放行。
3. 同一只读命令访问项目目录、用户目录和敏感目录时，行为语义保持一致，资源策略可分别决策。
4. 用户长时间停留在审批界面时，不被记为命令执行超时。
5. 日志能够说明：解析出了什么、每个执行单元是什么行为、访问什么资源、命中了哪条权限规则。

## 6. 暂定结论与待决事项

九个原子问题完成第一轮分析后，结论更新为：

1. “出现复杂 PowerShell 语法”不能直接推出“命令副作用未知”。
2. 当前问题跨越结构、语义、资源、策略、生命周期和提示，不应继续通过单个分类器补丁处理。
3. PowerShell 原生 AST 应成为成功解析后的唯一结构事实；Bash 使用自己的权威 parser，二者共享分层 IR 而不是字符扫描算法。
4. 命令语义应采用 identity、参数约束、effect 集合和资源参数描述，不能继续依赖命令字符串前缀。
5. PowerShell 表达式只分析有限可证明子集；脚本块递归分析，未知能力保守保留 evidence。
6. 复合结构需要 effect algebra 与状态传播，不能只取最高 sideEffect。
7. 终端必须产生结构化 resources；cwd 限制不是沙盒，工作区外访问由策略决定。
8. 统一权限服务应成为最终 `allow/ask/deny` 的唯一产生者，显式用户 allow 可以覆盖普通不确定性，但不能覆盖 invariant/deny/ask。
9. 审批、取消、排队和执行必须有独立状态与计时边界。
10. 工具描述必须准确反映真实能力，日志用脱敏结构证据替代完整命令正文。

## 7. 推荐实施拆分

不建议把全部内容放进一次大重构。按依赖和可独立验收性，推荐拆成以下 change：

| 顺序 | Change | 范围 | 完成后可独立获得的价值 |
|---|---|---|---|
| A | 权威 Shell IR | PowerShell AST 投影、POSIX parser 边界、删除双事实源 | 不再错误拆分复杂命令 |
| B | 原子命令能力注册 | identity、参数规则、effect/resource operand | 消除名称前缀误判 |
| C | PowerShell 表达式与 effect 聚合 | 有限表达式、脚本块、状态传播 | 区分正常计算与危险方法 |
| D | 终端资源分析 | 文件/provider/network/process 资源证据 | 权限层知道命令访问什么 |
| E | 统一权限策略 | 单一 decision、规则 candidate、mode/provenance | allow/ask/deny 行为一致且可复用 |
| F | 生命周期状态机 | typed outcome、取消、计时、effect | 审批与执行不再混淆 |
| G | 动态工具描述与可观测性 | 准确提示、分层事件、测试拆分 | 降低模型幻觉并可诊断 |

其中 A 是后续语义工作的前置条件；B、C、D 可以在 A 的 IR 稳定后分批实现；E 必须消费 B/C/D 的 evidence；F 可与 A-D 并行规划，但切换最终权限前应完成；G 贯穿每批并在最后收口。

## 8. 当前不建议做的事情

1. 不为 `[math]::Round()`、`ForEach-Object` 或某三条 C 盘命令直接增加生产特例。
2. 不把所有 PowerShell script block 全局加入只读白名单。
3. 不直接复制 Claude Code 当前快照的完整 allowlist 和安全补丁集合。
4. 不用系统提示词要求模型主动避开复杂命令来掩盖分析缺口。
5. 不在没有沙盒时声称命令只能操作工作区。
6. 不在本轮探索完成后立即一次性修改所有模块；应按 change 和验收门逐批推进。
