# Claude Code 权限与命令分析方案调研

> 调研日期：2026-07-14  
> 调研目标：为 MyAgent 阶段 3“统一权限和安全分析”提供事实依据  
> 调研范围：Claude Code 的权限模式、allow/ask/deny 规则、Bash 与 PowerShell 命令分析、复合命令处理、解析失败降级，以及与 MyAgent 当前终端链路的对比  
> 关联探索：[claude-code-sandbox-research.md](../../explorations/claude-code-sandbox-research.md)

## 1. 结论摘要

Claude Code 的核心经验不是“取消命令安全检查”，而是把原本容易混在一起的几个问题拆开：

1. 当前调用的工具是什么；
2. 命令能否被当前 Shell 可靠解析；
3. 命令包含哪些顶层命令、管道段、重定向和嵌套命令；
4. 每个子命令是否命中显式 deny、ask 或 allow 规则；
5. 命令是否命中语言级危险语义检查；
6. 当前权限模式是否允许自动执行；
7. 命令实际执行时是否位于 OS 沙盒内。

它们不是同一个安全判断。尤其需要明确：

- Plan 模式是权限模式，不是工作目录沙盒；
- 复合命令不是因为含有 ;、&& 或 | 就被统一拒绝；
- 复合命令也不是被直接放行，而是被解析后逐个子命令检查；
- Bash 和 PowerShell 使用不同的解析器和安全规则；
- 无法可靠解析时，Claude Code 会退回询问，而不是自动允许；
- OS 沙盒只解决进程实际能访问什么，不能替代应用层 deny/ask/allow 规则。

对 MyAgent 的直接启示是：阶段 3 应先重构“分析与决策链”，再放开可分析的复合命令。不能只删除 COMPOSITE_REGEX，也不能用一个跨 Shell 的正则替代解析器。

## 2. 证据来源与可信度

### 2.1 官方文档

官方文档用于确认当前公开语义：

- [Configure permissions](https://code.claude.com/docs/en/permissions)
- [Choose a permission mode](https://code.claude.com/docs/en/permission-modes)
- [Sandboxing](https://code.claude.com/docs/en/sandboxing)
- [Claude Code settings](https://code.claude.com/docs/en/configuration)

官方资料明确说明，当前公开权限模式包括 default、acceptEdits、plan、auto、dontAsk 和 bypassPermissions。规则层使用 deny、ask、allow，并按 deny → ask → allow 的优先级处理。

### 2.2 本地 Claude Code 参考源码

本次调研读取了 D:\projects\Agents\claude-code-analysis 中的源码，关键证据包括：

- Bash 权限入口：src/tools/BashTool/bashPermissions.ts
- Bash 安全检查：src/tools/BashTool/bashSecurity.ts
- Bash 命令拆分：src/utils/bash/commands.ts
- PowerShell 权限入口：src/tools/PowerShellTool/powershellPermissions.ts
- PowerShell 安全检查：src/tools/PowerShellTool/powershellSecurity.ts
- PowerShell 只读判定：src/tools/PowerShellTool/readOnlyValidation.ts
- PowerShell AST 解析：src/utils/powershell/parser.ts

源码快照文件时间主要为 2026-05-23，可能早于当前官方文档。因此，源码用于解释执行链，官方文档用于确认当前产品语义；二者冲突时不把源码快照当作最新行为的唯一依据。

## 3. Claude Code 的权限模型

### 3.1 权限模式和规则是两层机制

权限模式控制总体自动化程度，规则控制具体工具调用。官方语义可以概括为：

| 模式 | 默认自动行为 | 适用含义 |
|---|---|---|
| default | 读取通常可直接执行，其他工具调用按需询问 | 逐次审查 |
| acceptEdits | 工作区内文件编辑和少量常见文件系统操作自动执行 | 接受常规编辑 |
| plan | 读取和探索命令可执行，不修改源文件 | 先研究后实施 |
| auto | 后台安全检查后自动处理更多动作 | 减少确认次数 |
| dontAsk | 未预批准的工具直接拒绝 | 自动化脚本和 CI |
| bypassPermissions | 跳过权限提示 | 仅适合隔离容器或虚拟机 |

plan 并不表示“只能访问启动目录”。官方文档称它会读取文件、运行只读探索命令并生成计划；命令是否能访问工作区外路径，仍由工具权限、路径规则和实际执行环境共同决定。

### 3.2 规则优先级

权限规则形如：

    Bash(npm run *)
    PowerShell(Get-ChildItem *)
    Read(./.env)

同一工具的规则按以下优先级处理：

    deny > ask > allow

因此，不能因为某条命令命中了 allow，就跳过后续的显式拒绝规则。复合命令也不能只拿整串文本匹配一次，否则类似下面的规则会产生绕过：

    允许：Bash(echo *)
    拒绝：Bash(rm *)
    命令：echo safe && rm -rf /tmp/data

Claude Code 会把复合命令拆开，确保 rm 子命令仍然进入拒绝判断。

### 3.3 Plan、Auto 和 Bypass 的边界

- plan 是“只读工作模式”，不能被当作沙盒；
- auto 是在应用层做后台安全判断，不能等价于 OS 隔离；
- bypassPermissions 跳过大部分权限层，因此官方只建议在容器或虚拟机中使用；
- 即使存在 OS 沙盒，显式 deny 和关键系统路径删除保护仍然有效；
- 沙盒不可用时默认可以降级到普通权限流程，严格部署可以配置为不可用即失败。

## 4. Bash 方案：允许复合语法，但逐层检查

### 4.1 复合命令处理

官方文档列出的 Bash 分隔符包括：

    &&、||、;、|、|&、&、换行

Claude Code 不会仅凭这些符号拒绝命令。源码中的 Bash 权限链大致是：

    原始 Bash 命令
      ↓
    优先使用 AST 提取子命令
      ↓
    必要时回退到兼容拆分器
      ↓
    检查命令数量和复合结构
      ↓
    对每个子命令执行规则匹配、路径检查和安全语义检查
      ↓
    拒绝任一 deny 子命令
    询问任一 ask 或无法证明安全的子命令
    全部允许且无注入风险时才整体 allow

源码还设置了 MAX_SUBCOMMANDS_FOR_SECURITY_CHECK = 50。无法安全处理或拆分数量超过上限时，默认回到 ask，而不是为了完成任务而自动放行。

### 4.2 规则保存也按子命令处理

用户批准复合命令并选择“以后不要再问”时，Claude Code 保存的是需要批准的子命令规则，而不是把整串复合命令当成一个永久白名单。源码还限制一次最多建议 5 条规则，避免一个复杂命令污染权限配置。

这比“把当前完整命令加入 allowlist”更稳定，也更接近用户真正批准的粒度。

### 4.3 只读不是字符串前缀

Claude Code 对一组内置 Bash 命令做只读判定，包括 ls、cat、grep、find、wc、diff、stat、du 和只读形式的 git 等。

但只读判定仍然有条件：

- 参数可能改变命令副作用，例如 find -delete；
- 未引用的通配符可能展开成选项，导致原本看似只读的命令改变语义；
- cd 会产生路径资源判断；
- cd 与 git 组合会触发额外询问，防止工作目录切换后使用恶意裸仓库配置；
- 输出重定向仍然需要独立检查。

因此，MyAgent 的“命中只读白名单前缀即安全”不足以覆盖复合命令和参数语义。

## 5. PowerShell 方案：原生 AST + 子命令权限聚合

### 5.1 AST 解析结果

Claude Code 的 PowerShell 解析器通过 PowerShell 原生解析器生成结构化结果，而不是只扫描字符串。结果包含：

- 顶层语句；
- 管道中的命令段；
- 控制流和脚本块中的嵌套命令；
- 重定向目标；
- 变量和变量作用域；
- 别名和命令类型；
- 脚本块、子表达式、可展开字符串和成员调用；
- --% stop-parsing 标记；
- 类型字面量、模块加载和脚本要求等高风险结构。

PowerShell 的 ;、管道、PowerShell 7 的 && 和 || 都会进入子命令分析。常用别名会先归一化，例如 ls、dir、gci 归一化为 Get-ChildItem，rm、ri、del 归一化为 Remove-Item。

### 5.2 权限入口的实际顺序

powershellToolHasPermission 和 powershellToolCheckPermission 体现了以下原则：

1. 先检查完整命令的显式规则；
2. 显式 deny 可以立即返回；
3. 显式 ask 不能提前返回并跳过子命令的拒绝检查，而是暂存到汇总阶段；
4. 解析整个 PowerShell 命令；
5. 提取管道、语句和嵌套控制流中的每个命令；
6. 对每个子命令分别执行 deny、ask、allow 和安全语义检查；
7. 任一子命令 deny，则整体 deny；
8. 没有 deny 但存在 ask、解析失败或安全检查无法证明时，整体 ask；
9. 只有全部子命令允许且没有安全注入风险时，整体 allow。

源码特别处理了一个重要边界：如果 PowerShell AST 解析失败，仍会用保守的分隔符扫描来检查子命令 deny 规则。解析失败只意味着无法做精确分析，不意味着可以绕过拒绝规则。

### 5.3 PowerShell 的安全语义不止写命令

powershellSecurity.ts 还会检查：

- Invoke-Expression 和动态命令名；
- -EncodedCommand；
- 下载执行链；
- Add-Type、COM 对象和 .NET 成员调用；
- Start-Process；
- 脚本块、子表达式、可展开字符串和 splatting；
- 模块加载、环境变量操纵、计划任务、WMI 进程生成；
- 远程会话和 UNC 路径。

这表明复合命令支持的前提不是“允许所有特殊字符”，而是“用 Shell 语法结构识别真实执行面”。

## 6. 与 MyAgent 当前实现的对比

当前 MyAgent 已经完成了 Bash/PowerShell 工具拆分和 shell family 分发，这是正确方向。但阶段 3 仍存在以下结构性差距：

| 维度 | Claude Code | MyAgent 当前实现 |
|---|---|---|
| 复合命令 | 解析后逐个子命令检查 | terminal-guard.ts 用 COMPOSITE_REGEX 直接拒绝复合符号 |
| Bash 分析 | AST、命令安全检查、路径和重定向检查 | 主要依赖白名单、正则和结构字符检查 |
| PowerShell 分析 | 原生 PowerShell AST，包含嵌套命令和安全节点 | 当前是 shell family 分发和正则判断，尚未形成 AST 级分析 |
| 权限聚合 | 子命令结果汇总，deny 优先，未知回到 ask | checkSafety、checkPermissions 和执行期校验存在重复判断 |
| Plan 安全 | 只读模式下允许探索命令，但仍由权限规则约束 | isPlanSafeCommand 依赖 validateCommand，复合命令因此无法进入安全集合 |
| 实际副作用 | 应用层决策与执行环境分开 | securityCategory = write 容易与单条命令真实副作用混淆 |
| 工作目录 | 属于路径权限和工具规则的一部分 | validateCwd 只做路径范围校验，不是 OS 沙盒 |
| 解析失败 | 保守降级为询问，并继续做关键 deny 检查 | 当前没有统一的“解析失败但继续做最低限度拒绝检查”模型 |

当前最明显的阻碍是：

    isPlanSafeCommand(command)
      -> validateCommand(command)
         -> 复合字符检查
            -> 复合命令直接失败

因此，即使前面的权限逻辑已经准备区分读取、敏感读取和写入，复合命令仍会在执行期结构校验处被截断。

## 7. 对阶段 3 的具体建议

### 7.1 采用 Claude Code 的语义，不复制其全部实现

推荐把 Claude Code 的以下语义作为 MyAgent 基线：

1. deny > ask > allow；
2. 复合命令逐个子命令检查；
3. 任何子命令拒绝，整体拒绝；
4. 任何子命令需要询问或无法证明安全，整体询问；
5. 全部子命令允许且无危险语义，整体允许；
6. 解析失败时保守询问，并继续执行最低限度的 deny 检查；
7. Bash 与 PowerShell 使用不同的分析器；
8. 工具能力、命令副作用、权限结果和 OS 执行环境分别建模。

不建议复制 Claude Code 的完整实现，因为它包含大量与 Anthropic 产品、后台分类器、UI 提示、遥测和特定平台兼容相关的代码。MyAgent 应复用语义和边界，而不是照搬实现细节。

### 7.2 阶段 3A：先建立统一分析契约

建议形成如下概念模型：

    CommandAnalysis
      - shellKind
      - parseStatus: parsed | degraded | invalid
      - subcommands[]
      - resources[]
      - riskSignals[]
      - overallRisk

    SubcommandAnalysis
      - text
      - executable
      - arguments
      - operation: read | sensitive-read | write | network | execute | unknown
      - pathResources[]
      - securitySignals[]

    PolicyDecision
      - effect: allow | ask | deny
      - reason
      - matchedRule
      - affectedSubcommands[]

这不是要求立即建立一个庞大的抽象层，而是先规定“分析结果”和“权限结果”不能继续使用多个互相重复的布尔值表达。

### 7.3 阶段 3B：统一决策入口

checkSafety、checkPermissions 和 resolveExecutionEffect 应共享同一份分析结果和决策规则：

    Shell-specific analyzer
      -> shared command analysis
      -> shared deny/ask/allow policy
      -> execution adapter

其中：

- 分析器负责理解 Bash 或 PowerShell；
- 策略层负责统一处理 PermissionMode、规则优先级和聚合；
- 执行适配器只负责 cwd、环境变量、超时、输出和进程生命周期；
- 执行适配器不应再次用另一套正则决定命令是否安全。

### 7.4 阶段 3C：放开可分析的复合命令

不能直接删除所有结构检查。应改成：

- 已识别并可逐段分析的复合命令进入权限流程；
- 纯读取复合命令可按规则自动允许；
- 读取 + 写入整体至少询问；
- 命中硬性危险语义整体拒绝；
- 包含未知结构、解析失败或无法确定副作用时整体询问；
- 子命令数量过多时整体询问；
- 引号、转义和脚本块内部的分隔符不能被误拆成多个命令。

首批实现不必覆盖 Bash 和 PowerShell 的全部语言特性，但必须明确：未覆盖语法进入 unknown/ask，不能进入 allow。

### 7.5 阶段 3D：清理重复和误导性命名

在统一入口稳定后，再处理：

- COMPOSITE_REGEX 从“安全拒绝器”降级为解析失败或结构异常信号，不能继续负责一律拒绝；
- securityCategory = write 改成工具能力元数据，不能作为命令副作用结论；
- 删除或迁移重复的 checkSafety / checkPermissions 判断；
- 清理已经没有调用方的兼容接口和 deprecated 导出；
- 将 validateCwd 的注释从“沙箱隔离”改为“工作目录范围校验”，避免安全承诺与实现不符。

## 8. 阶段 3 验收矩阵

| 场景 | 预期结果 |
|---|---|
| Bash 单条普通读取 | 根据权限模式和规则允许或无需询问 |
| PowerShell 单条普通读取 | 根据 PowerShell AST 和别名归一化后处理 |
| Get-ChildItem C:\Users | 不因超出 cwd 就直接假定为 OS 沙盒违规；按路径规则询问或允许 |
| Get-ChildItem; Get-Process | 两个子命令分别分析，全部安全时整体允许 |
| Get-ChildItem; Remove-Item | 写入/删除子命令使整体至少询问 |
| echo safe && rm -rf path | rm 命中 deny 或危险语义时整体拒绝 |
| 管道和重定向 | 分别分析管道段和重定向目标，不能只看首命令 |
| 引号内包含分隔符 | 不得误拆成真实子命令 |
| PowerShell 脚本块、子表达式、别名 | 通过 AST 和归一化检查，不能只看首个字符串 |
| 解析失败 | 保守询问，并继续做最低限度的 deny 检查 |
| 子命令过多 | 询问，不自动放行 |
| 硬性毁灭命令 | 直接拒绝，不能被 allow 规则覆盖 |
| bypassPermissions | 只绕过应用层普通询问，不删除硬性安全边界 |
| Plan 模式 | 允许只读探索，不修改源文件；不把它当成 cwd 沙盒 |

## 9. 不属于本阶段的内容

本次调研不建议把下列工作混入阶段 3：

- Docker、WSL2 或原生 Windows PowerShell OS 沙盒；
- Codex/Gemini 风格的 restricted token、ACL、Firewall 和管理员 setup；
- 完整复制 Claude Code 的后台安全分类器；
- 一次性实现完整 Bash、PowerShell 语言解析器；
- 因为复合命令支持而删除硬性危险拦截；
- 把 cwd 校验、权限询问或命令正则宣称为沙盒。

沙盒和其他竞品的 Windows 隔离方案已经记录在 [claude-code-sandbox-research.md](../../explorations/claude-code-sandbox-research.md)，应作为后续独立平台安全项目的输入，而不是阶段 3 的实现前提。

## 10. 最终建议

推荐 MyAgent 按以下顺序推进：

    3A 统一 CommandAnalysis / PolicyDecision 契约
      ↓
    3B Bash、PowerShell 分析器接入同一权限决策入口
      ↓
    3C 放开可分析的复合命令，未知结构默认 ask
      ↓
    3D 将执行期校验收缩为运行时约束，清理重复安全判断
      ↓
    3E 自动测试 + 手动测试 + 日志验证
      ↓
    后续独立评估 OS 沙盒或执行后端

最终应达到的不是“命令越自由越好”，也不是“命令越少越安全”，而是：

> Claude Code 可以执行复合命令，是因为它把 Shell 语法解析、子命令权限、危险语义、权限模式和 OS 执行环境分层处理；MyAgent 阶段 3 应先建立这条分层链路，再逐步放宽当前过于粗粒度的复合命令拒绝。

## 11. 权限模式的进一步细节

前文的模式表描述了用户可见行为，但 Claude Code 在实现上还区分内部模式和外部模式：

- `default` 是内部配置值，界面可以显示为 Manual；
- `auto` 不是所有配置入口都允许直接设置的普通模式；
- `dontAsk` 不出现在普通模式循环中，需要显式设置；
- 模式可以在启动时、会话中或持久化配置中设置；
- 模式只提供基础策略，规则仍然作为独立覆盖层生效。

特别是 `bypassPermissions` 也不是绝对放行：显式 `ask` 规则和根目录、主目录删除等安全断路器仍然可以要求询问。Auto 模式也不是 Bypass，而是由后台安全分类器对动作进行二次判断；连续或累计拒绝达到阈值后会回退到人工询问。

Plan 模式的完整流程是：读取和探索 → 生成计划 → 用户选择批准方式 → 切换到 auto、acceptEdits 或人工模式 → 执行修改。它是会话工作流，不是 cwd 沙盒。

## 12. 权限规则的来源和更新

Claude Code 的规则不仅保存工具和匹配内容，还保留规则行为和来源。规则来源包括用户设置、项目设置、本地设置、命令行参数、策略设置、命令和当前会话。

用户选择“以后不要再问”时，系统会生成规则更新，而不是简单把当前完整请求标记成永久允许。复合命令最多为需要批准的子命令分别生成规则，避免整条命令字符串成为过宽的白名单。

因此，权限系统至少需要区分：

- 规则内容；
- `allow`、`ask` 或 `deny` 行为；
- 规则来源；
- 规则保存目标；
- 当前会话有效还是持久化有效。

## 13. 权限请求不是一次性异常

Claude Code 的工具前置钩子 `PreToolUse` 可以返回 `allow`、`deny`、`ask` 或 `defer`。多个钩子同时返回结果时，优先级为：

    deny > defer > ask > allow

钩子不能绕过更高优先级的权限规则：匹配的 deny 仍然会阻止执行，匹配的 ask 仍然会强制询问。钩子还可以在执行前修改工具输入。

`defer` 用于没有交互终端的集成场景：工具不执行，调用方拿到待处理工具请求并收集用户输入，之后使用原会话恢复；同一个工具请求会再次经过前置钩子，最终由 `allow` 或 `deny` 决定是否执行。

这意味着“询问”不能只实现为抛出一个错误。完整模型需要支持：

1. 保存工具请求和输入；
2. 暂停当前会话；
3. 从外部界面取得决定；
4. 恢复原会话；
5. 防止恢复前重复执行；
6. 记录最终决定及其来源。

## 14. 阶段 3 调研结论更新

本文件现在覆盖阶段 3 所需的 Claude Code 语义：

1. 工作模式是会话级基础策略；
2. 权限规则是独立覆盖层，优先级为 deny > ask > allow；
3. Shell 分析负责产生证据，不直接等价于最终放行；
4. 复合命令必须逐个子命令分析；
5. 权限结果需要携带原因、来源和受影响的子命令；
6. 审批是可以暂停、保存和恢复的生命周期；
7. 钩子可以参与权限决策，但不能绕过更高优先级的拒绝规则；
8. Auto、Plan 和 Bypass 是不同的机制，不能合并成一个开关。

因此，之前的命令权限调研和本次补充属于同一个阶段 3 探索，不应拆成两个平行文档。后续如果需要进入 MyAgent 代码设计，应以本文件作为唯一的 Claude Code 语义依据。

补充官方依据：

- [Claude Code 权限模式](https://code.claude.com/docs/en/permission-modes)
- [Claude Code Hooks](https://code.claude.com/docs/en/hooks)
- [Claude Code 设置](https://code.claude.com/docs/en/settings)
