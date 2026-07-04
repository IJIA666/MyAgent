# 探索主题: 多平台终端 Shell 抽象分层

## 1. 问题定义

当前仓库对大模型只暴露一个 `execute_command` 工具，但其内部已经混合承载了 Windows、PowerShell、`cmd`、类 POSIX shell 的解析、审批和执行细节。项目后续至少需要正式适配 Linux，因此需要明确：多平台支持应当落在“多个顶层工具名”上，还是落在“单一工具 + 内部分层抽象”上。

## 2. 关键发现与调研结果

- **代码库现状**
  - 当前系统工具层只注册了一个终端执行工具 `ExecuteCommandTool`，见 [index.ts](/D:/projects/MyAgent/src/adapters/tools/impl/system/index.ts:10) 和 [terminal.ts](/D:/projects/MyAgent/src/adapters/tools/impl/system/terminal.ts:25)。
  - 真实调用链是：模型工具参数先在 [agent-loop.ts](/D:/projects/MyAgent/src/core/usecases/engine/agent-loop.ts:557) 解析，再经 [toolRegistry.ts](/D:/projects/MyAgent/src/adapters/tools/toolRegistry.ts:76) 进入 [virtual-mcp.ts](/D:/projects/MyAgent/src/adapters/tools/virtual-mcp.ts:141)，最后调用 [terminal.ts](/D:/projects/MyAgent/src/adapters/tools/impl/system/terminal.ts:156) 执行。
  - 这说明若要引入新的 shell 抽象，最稳定的主边界不是审批层或全局状态层，而是“工具入参 -> 终端执行工具 -> 执行计划”这条主链。
  - 当前安全解析已经显式识别 `sh|bash|cmd|powershell|pwsh`，见 [terminal-guard.ts](/D:/projects/MyAgent/src/adapters/tools/impl/system/terminal-guard.ts:320)。也就是说，仓库事实上已经承认 shell family 差异存在，只是还没有形成受控抽象。
  - 当前只读白名单和安全评级明显带有 Windows/PowerShell 倾向，例如 [terminal-guard.ts](/D:/projects/MyAgent/src/adapters/tools/impl/system/terminal-guard.ts:146) 的 `READONLY_COMMAND_WHITELIST` 与 [terminal-guard.ts](/D:/projects/MyAgent/src/adapters/tools/impl/system/terminal-guard.ts:157) 的 PowerShell 写操作正则。若未来正式适配 Linux，这种“平台语义混写”会继续扩大。
  - 当前执行引擎直接内嵌了 Windows 特化分支，包括 npm/npx 的 `.cmd` 重定向、PowerShell 编码修正以及 `shell: false` 执行模型，见 [terminal-engine.ts](/D:/projects/MyAgent/src/adapters/tools/impl/system/terminal-engine.ts:284)、[terminal-engine.ts](/D:/projects/MyAgent/src/adapters/tools/impl/system/terminal-engine.ts:296)、[terminal-engine.ts](/D:/projects/MyAgent/src/adapters/tools/impl/system/terminal-engine.ts:418)。这些逻辑现在还没有被一个明确的“执行计划对象”接住。
  - 当前配置层只管理 `WorkMode` 与命令白名单，不管理默认 shell family，见 [terminal-config.ts](/D:/projects/MyAgent/src/adapters/tools/impl/system/terminal-config.ts:20) 和 [terminal-config.ts](/D:/projects/MyAgent/src/adapters/tools/impl/system/terminal-config.ts:32)。
  - 当前审批策略已经把 `execute_command`、`bash`、`powershell` 视为同类终端工具名称，见 [ApprovalPolicy.ts](/D:/projects/MyAgent/src/core/usecases/security/ApprovalPolicy.ts:267)，但仓库真实注册出来的只有 `execute_command`。这说明安全层已经泄露出“多壳语义”，而工具暴露层并未形成一致模型。

- **外部核实与洞察**
  - OpenClaw 官方当前是单一 `exec` 工具，而不是把 `cmd`、`powershell`、`bash` 暴露成并列顶层工具；其文档强调 `pty`、`host`、`timeout` 等执行属性，并说明非 Windows 主机使用 `SHELL`，Windows 主机优先 `pwsh` 后回退 Windows PowerShell，见 [OpenClaw Exec tool](https://docs.openclaw.ai/tools/exec)。
  - OpenCode 官方当前对模型暴露的是单一 `bash` 工具，见 [OpenCode Tools](https://opencode.ai/docs/tools/)；但其源码在 Windows 上仍默认回退 `cmd.exe`，并保留“恢复 PowerShell/cmd 专项处理”的 TODO，见 [bash.ts](/D:/projects/Agents/opencode/packages/core/src/tool/bash.ts:49) 和 [bash.ts](/D:/projects/Agents/opencode/packages/core/src/tool/bash.ts:69)。这说明“单工具命名”并不会消除多平台复杂度，只会把复杂度下沉到内部。
  - Claude Code 官方文档明确区分 Windows PowerShell 与 Windows CMD 安装方式，并说明原生 Windows 安装推荐 Git for Windows 以启用 Bash tool，否则回退到 PowerShell，见 [Claude Code Overview](https://code.claude.com/docs/en/overview)。同时，本地分析仓库中也确实存在独立的 [BashTool](</D:/projects/Agents/claude-code-analysis/src/tools/BashTool/BashTool.tsx:421>) 与 [PowerShellTool](</D:/projects/Agents/claude-code-analysis/src/tools/PowerShellTool/PowerShellTool.tsx:273>)。
  - 综上，竞品并不存在统一答案。更稳定的共识不是“都拆成多个 shell 工具”，而是“都必须承认多平台 shell 语义差异，并在内部给出明确边界”。

## 3. 方案对比与推荐方向

| 评估维度 | 方案 A：继续维持当前大一统 `execute_command`，不新增抽象 | 方案 B：直接暴露 `bash` / `powershell` / `cmd` 多个顶层工具 | 方案 C：保留单一 `execute_command`，内部新增 `shellKind` 与 `ShellExecutionPlan` |
| :--- | :--- | :--- | :--- |
| 多平台适配清晰度 | 低，平台特化继续散落在 guard/engine/policy | 中，模型层清楚，但内部仍需重复处理平台差异 | 高，平台差异集中在受控抽象层 |
| 模型心智复杂度 | 低 | 高，需要模型自行选壳 | 低，默认 `auto` 即可 |
| 审批与安全策略复用 | 低，现有混杂继续扩大 | 低到中，多个工具将带来并行策略面 | 高，可复用统一审批框架，只在解析层分壳 |
| Linux 扩展成本 | 高，现有 Windows 倾向规则会继续污染 POSIX 场景 | 中，需要补全多工具契约和提示词 | 低到中，只需扩展 `shellKind -> plan` 映射 |
| 与现有调用链兼容性 | 高，但问题继续累积 | 低，需要调整工具暴露层和提示词 | 高，只需在现有 `execute_command` 入参和内部链路上演进 |
| 推荐结论 | 不推荐 | 不推荐 | 推荐 |

**推荐路径**：方案 C。保留对外单一 `execute_command`，但新增可选 `shellKind`，推荐取值为 `auto | posix | powershell | cmd`。再在内部新增类似 `ShellExecutionPlan` 的中间层，将“平台默认值选择”“命令归一化”“安全解析模式”“实际 `exe + argv` 生成”统一收口，避免未来 Linux 支持继续直接堆叠在 `terminal-guard.ts` 和 `terminal-engine.ts` 上。

## 4. 约束、风险与未知项

- `shellKind` 的对外枚举更适合表达“语义家族”而不是具体可执行文件名。若直接暴露 `bash`、`zsh`、`sh`，模型层会承担不必要的平台细节。
- 现有 `extractSafePrefix()` 与命令白名单是按“根命令 + 子命令”提取的，见 [terminal-config.ts](/D:/projects/MyAgent/src/adapters/tools/impl/system/terminal-config.ts:193)。引入 `shellKind` 后，需要确认该规则是否继续跨 shell 通用，还是应改为由执行计划层按 shell 语义提取。
- 现有 `unboxNestedCommand()` 会主动剥壳，见 [terminal-guard.ts](/D:/projects/MyAgent/src/adapters/tools/impl/system/terminal-guard.ts:297)。若未来模型显式传入 `shellKind`，需要重新界定“显式壳选择”和“嵌套壳包装”的优先级，避免出现双重推断。
- 当前 `ApprovalPolicy` 已经接受 `bash` / `powershell` 名称分支，但仓库并未真正注册这些工具，见 [ApprovalPolicy.ts](/D:/projects/MyAgent/src/core/usecases/security/ApprovalPolicy.ts:267)。后续设计要避免继续扩大这种“策略层先知道、工具层未成型”的不一致。
- 当前结论只覆盖终端 shell 抽象边界，不包含具体实现方案、迁移步骤、测试矩阵和配置落盘格式；这些内容应放入后续 change proposal，而不是继续塞进探索结论。

## 5. 否决方案

- **直接把 `cmd` 提升为一等模型工具**：不推荐。`cmd` 更像 Windows 兼容回退层，而不是值得长期鼓励的大模型主执行语义。
- **先把 shell 差异放进审批层**：不推荐。审批层应消费归一化后的执行计划，不应反过来决定命令用什么壳执行。
- **只在全局配置里增加默认 shell，不给单次调用入参留显式表达能力**：不推荐。这样会让模型调用粒度失去可控性，无法稳妥支撑多平台、多场景切换。
- **继续维持当前隐式混合状态**：不推荐。仓库已经出现 shell family 识别、Windows 特化执行和策略层名称泄露三套并存的迹象，继续放任只会让 Linux 适配成本更高。
