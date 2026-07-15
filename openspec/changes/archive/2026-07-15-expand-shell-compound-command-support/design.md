## 背景

阶段 3 已建立 `ShellCommandAnalysis`、分 Shell 分发、hardline 优先聚合和统一权限证据，但当前 `shell-command-scanner.ts` 只可靠识别少量顶层连接符。`terminal.ts` 与 `terminal-guard.ts` 仍会拒绝所有非 `parsed` 输入，因此仅修改字符白名单无法实现 Claude Code 级复合命令能力。

既有探索表明，Claude Code 的 Bash 路线是 Shell token/parser 加安全加固，PowerShell 路线是原生 AST；两者都会逐个检查管道段、重定向和嵌套命令，并在无法证明安全时询问，而不是自动放行。

## 目标与非目标

**目标:**

- 分批支持纯读取管道、完整条件链、重定向、后台执行和嵌套结构。
- Bash 以 Claude Code 的已调研语法行为为最低兼容目标；PowerShell 使用自身 AST 取得等价证据。
- 保持 hardline 不可绕过，并使合法但未覆盖的结构只能 ask/deny。
- 每类语法拥有独立开关、测试和回退路径；最终启用已通过验收的批次。
- 权限与执行期复用同一份异步分析结果，不发生二次解析漂移。

**非目标:**

- 不实现 Shell 解释器、OS 沙盒或后台安全分类器。
- 不承诺 CMD 复合语法与 Bash/PowerShell 同步开放。
- 不允许动态求值、编码命令或无法检查的展开绕过 hardline。
- 不修改模型可见的 `execute_command` Schema、权限模式或审批 UI。

## 架构决策

### 1. 将分析器升级为异步解析门面

`ShellCommandAnalyzer.analyze()` 与 `analyzeShellCommand()` 改为返回 Promise。`NativeTool.checkPermissions()` 已支持异步结果，因此无需新增第二套权限入口。原子命令副作用分析和 hardline 扫描仍保持纯函数；解析器只负责产生结构，不直接决定 allow/ask/deny。

Bash 使用成熟的 Shell token/parser 处理控制操作符、引号、转义、换行、管道和重定向，并针对 heredoc、动态展开、静态重定向目标及 parser differential 增加显式防护。PowerShell 通过受控子进程调用 `System.Management.Automation.Language.Parser`，返回最小化 JSON AST；命令文本通过 stdin 或等价无插值通道传入，解析设置短超时、输出上限和 LRU 缓存。CMD 继续使用现有保守分析器。

不继续扩展单一有限状态扫描器，因为它无法可靠覆盖脚本块、子表达式和重定向组合；也不复制 Claude Code 完整实现，只复用已调研的语义和边界。

### 2. 用结构化节点表达复合命令证据

扩展 `types.ts`，使分析结果能够表达 `;`、`&&`、`||`、`|`、`|&`、`&`、换行、重定向以及父子嵌套关系。每个可执行节点记录命令文本、连接关系、嵌套路径、副作用、资源和权限建议；重定向单独记录源流、操作符、静态目标和 read/write effect。

聚合规则保持固定：任一 hardline/deny 则整体 deny；任一 ask、未知 effect 或不完整分析则整体 ask；只有所有可执行节点和重定向均为 allow 才整体 allow。`invalid` 直接 deny；语法有效但能力未覆盖、解析器不可用或超过 50 个可执行节点时，在完成最低限度 deny 扫描后 ask。动态求值、编码命令和会隐藏真实执行面的结构按 hardline/deny 处理。

### 3. 五类语法使用独立能力开关

在命令分析域内定义不可变 `ShellCompoundFeatureConfig`，包含 `pipelines`、`conditionals`、`redirections`、`background`、`nested`。正常工具构造默认启用全部已验收能力；工具工厂仅保留可选构造参数，供回退测试与内部诊断显式关闭单项能力。该配置不进入 `AppConfig`，也不读取或暴露环境变量。

实现顺序固定为：纯读取管道 → 条件链 → 重定向 → 后台执行 → 嵌套结构。内部覆盖开关关闭时，对应合法结构返回 ask 而不是伪装成 parsed；已识别 hardline 仍 deny。全部批次通过分析、权限、执行和平台测试后，正常运行默认启用，CMD 仍保持保守边界。

### 4. 审批后不得被执行期重复拒绝

`terminal.ts` 将 `unsupported` 映射为 ask、`invalid` 和 hardline 映射为 deny。授权上下文继续携带完整 evidence。`terminal-guard.ts` 的执行前检查只验证授权证据、cwd 和不可绕过的运行时约束，不得重新调用分析器并依据 `parseStatus !== parsed` 拒绝已批准命令。

Plan 模式仅允许可证明为 read/sensitive-read 的 parsed 结构；unsupported 即使可在普通模式询问，也不能在 Plan 中自动执行。后台操作必须进入现有任务托管、超时和进程树清理生命周期；不能被托管时保持 ask/deny，不能仅因为 `&` 被 Shell 接受就标记完成。

## 风险与权衡

- **Parser 与真实 Shell 语义出现差异** → 建立来自既有探索的攻击/兼容语料，并用真实 Bash、PowerShell 执行夹具验证结构提取；解析异常不得 allow。
- **PowerShell AST 子进程增加延迟** → 已由轻量 scanner 完整证明的原子命令不启动子进程；复杂结构使用最小 JSON、短超时和有界 LRU 缓存，解析器不可用时退回 ask，不静默切换 Shell。
- **后台操作脱离生命周期管理** → 只有接入现有 task id、取消、超时和进程树清理后才启用 background 开关。
- **能力开关长期形成双路径** → 开关只控制语法批次，不复制权限算法；所有路径共享同一分析与聚合实现。
- **unsupported 经审批执行可能隐藏硬线操作** → 先运行 Shell 专用最低限度扫描，并对动态求值/编码执行直接 deny；不得持久化整串未知命令为宽泛 allow 规则。

## 迁移计划

1. 扩展异步分析契约、结构化节点和能力开关，默认保持阶段 3 行为。
2. 接入 Bash token/parser 与 PowerShell AST 适配器，先锁定原子命令和既有连接符回归。
3. 依次实现并验收 pipelines、conditionals、redirections、background、nested；每批只开启对应开关。
4. 调整 `terminal.ts` 的 unsupported ask 映射，并移除 `terminal-guard.ts` 的执行期二次解析拒绝。
5. 完成单元、权限聚合、真实 Shell 集成和内部回退测试后，正常运行默认启用全部已验收批次；诊断回滚通过构造参数关闭对应能力，不恢复旧决策链。
