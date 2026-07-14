# Claude Code 沙盒方案调研

> 调研日期：2026-07-14  
> 调研范围：Claude Code 的 Bash 沙盒、权限协作、复合命令处理、平台支持及安全边界  
> 调研目的：为 MyAgent 阶段 2 的沙盒设计提供事实依据，不直接预设实现方案

## 1. 调研结论摘要

Claude Code 的沙盒不是“取消命令限制”的开关，而是由两部分共同组成：

1. 应用层权限系统，负责在执行前判断工具调用、完整命令和子命令是否命中 `allow`、`ask`、`deny` 规则；
2. 操作系统级沙盒，负责限制 Bash 进程及其子进程实际能够访问的文件系统和网络资源。

Claude Code 不会因为命令包含 `;`、`&&`、`|` 或重定向就统一拒绝，但也没有完全取消命令安全检查。它会继续解析复合命令、检查危险语法和显式权限规则，最终依靠 OS 级边界限制命令的实际影响范围。

Claude Code 的沙盒具有明确的平台和工具范围限制：

- 只覆盖 Bash 及 Bash 启动的子进程；
- 不覆盖 Read、Write、Edit、Glob、Grep 等运行在 Claude Code 主进程中的工具；
- 支持 macOS、Linux 和 WSL2；
- 不支持原生 Windows；
- WSL2 沙盒内不能直接调用 `powershell.exe`、`cmd.exe` 或 `/mnt/c/` 下的 Windows 程序。

因此，不能把 Claude Code 的方案概括为“给 Bash 和 PowerShell 都套一个跨平台沙盒”。如果 MyAgent 要在原生 Windows PowerShell 上提供真正的 OS 级隔离，那将是 MyAgent 自己的扩展，不是 Claude Code 当前方案的复刻。

## 2. 证据来源与可信度

本次调研使用三类证据，并按以下优先级解释：

1. Anthropic 官方 Claude Code 文档：用于确认当前公开行为和配置语义；
2. `D:\projects\Agents\claude-code-analysis\src` 中的 Claude Code 源码快照：用于确认执行链和实现细节；
3. `D:\projects\Agents\claude-code-analysis\analysis` 中的人工分析文档：只作为定位线索，若与源码或官方文档冲突，以源码和官方文档为准。

需要注意版本差异：源码快照文件时间主要为 2026-05-23，分析文档更新时间为 2026-07-13，而官方文档是当前公开版本。因此，源码快照不能覆盖官方文档中后来增加的所有功能，例如较新的凭据保护配置。

本地源码快照还引用了 `@anthropic-ai/sandbox-runtime`，但没有包含该依赖的完整源码。因此，底层 runtime 的所有实现细节不能仅凭本地快照确认。

## 3. Claude Code 的执行链

源码中可以观察到以下执行链：

```text
Bash 工具调用
  -> BashTool 权限判断
     -> shouldUseSandbox()
        -> 未启用或命中 excludedCommands：普通执行路径
        -> 进入沙盒：继续进行沙盒自动放行判断
  -> 检查完整命令的 deny / ask 规则
  -> 拆分复合命令
  -> 检查每个子命令的 deny / ask 规则
  -> Bash 安全校验
  -> Shell.ts 构造实际 Shell 命令
  -> sandbox-runtime 包装
  -> 启动 Bash 或 PowerShell 子进程
  -> 命令结束后清理沙盒残留
```

对应的本地源码包括：

- `D:\projects\Agents\claude-code-analysis\src\tools\BashTool\shouldUseSandbox.ts`
- `D:\projects\Agents\claude-code-analysis\src\tools\BashTool\bashPermissions.ts`
- `D:\projects\Agents\claude-code-analysis\src\tools\BashTool\bashSecurity.ts`
- `D:\projects\Agents\claude-code-analysis\src\utils\Shell.ts`
- `D:\projects\Agents\claude-code-analysis\src\utils\sandbox\sandbox-adapter.ts`

### 3.1 是否进入沙盒

`shouldUseSandbox()` 的判断条件包括：

- 沙盒在当前平台可用且已启用；
- 没有显式要求禁用沙盒，或者策略不允许非沙盒执行；
- 命令存在；
- 命令没有命中 `excludedCommands`。

源码中特别说明，`excludedCommands` 是用户便利配置，不是安全边界。命令命中该配置后可以绕过沙盒，但仍应进入普通权限系统，而不能被当作安全命令自动放行。

### 3.2 沙盒自动放行

当 `autoAllowBashIfSandboxed` 开启，并且当前命令确实进入沙盒时，Claude Code 才可能自动放行 Bash 命令。

自动放行之前仍然会检查：

1. 完整命令是否命中显式 `deny`；
2. 每个复合子命令是否命中显式 `deny`；
3. 完整命令或子命令是否命中显式 `ask`。

优先级是 `deny` 高于 `ask`，`ask` 高于沙盒自动放行。

这意味着沙盒自动放行不是“进入沙盒后所有命令都无条件允许”。它是“OS 边界可用时，减少普通确认次数”，而不是覆盖显式权限规则。

## 4. 复合命令处理

### 4.1 Claude Code 没有统一禁止复合符号

Claude Code 的 Bash 工具允许常见 Shell 复合语法进入后续处理流程，例如：

```bash
pwd && node --version
npm test 2>&1 | tee test.log
git status; git diff
```

它与 MyAgent 当前 `terminal-guard.ts` 的差异非常明显。MyAgent 当前通过 `COMPOSITE_REGEX` 和 `COMPOSITE_CHARS` 直接拒绝 `;`、`&`、`|`、`<`、`>` 等字符，并明确要求终端工具只执行原子命令。

### 4.2 Claude Code 仍然检查复合命令

Claude Code 的 `bashPermissions.ts` 使用命令拆分逻辑检查每个子命令。这样可以避免以下绕过：

```text
echo safe && rm -rf /
```

如果只检查完整命令，`Bash(rm:*)` 这类前缀规则可能无法命中，因为完整字符串是以 `echo` 开头。Claude Code 因此先拆分子命令，再逐个检查 deny / ask 规则。

同时，`bashSecurity.ts` 仍保留大量针对 Bash 语义的检查，包括：

- 命令替换；
- 进程替换；
- 危险重定向；
- heredoc；
- 环境变量注入；
- `/proc/environ` 访问；
- 转义操作符；
- zsh 特有危险命令；
- malformed token 和引号错位。

因此，Claude Code 的真实策略是：

> 允许复合命令作为 Shell 语言执行，但不把复合语法本身当成安全证明，也不取消语义级安全校验。

## 5. 沙盒底层能力

官方公开的 `@anthropic-ai/sandbox-runtime` 使用原生 OS 机制：

- macOS 使用 `sandbox-exec` / Seatbelt；
- Linux 使用 bubblewrap；
- 网络访问通过代理和域名规则控制。

当沙盒进程访问被禁止的资源时，底层会阻止操作并返回错误。Claude Code 可以把这类违反行为转化为权限提示或普通权限流程。

### 5.1 文件系统默认边界

默认情况下，沙盒命令可以：

- 读当前计算机的大部分文件；
- 写当前工作目录及其子目录；
- 写沙盒专用临时目录；
- 通过 `sandbox.filesystem.allowWrite` 扩展额外写目录；
- 通过 `denyRead`、`denyWrite` 和 `allowRead` 进一步收缩边界。

这说明 Claude Code 的默认沙盒不是“工作区只读/只写的完整黑盒”。默认写边界比较窄，但默认读边界仍然较宽，凭据文件需要单独配置保护。

### 5.2 网络边界

网络访问由沙盒外部的代理控制：

- 默认没有预先允许的域名；
- 首次访问新域名时可以请求批准；
- 可以通过 `allowedDomains` 和 `deniedDomains` 配置；
- 可以通过 managed settings 强制只使用管理员允许的域名；
- 默认不解密检查 TLS 内容；
- 允许过宽域名可能产生数据外泄风险。

网络沙盒不是完整的内容审计系统。域名 allowlist、TLS 检查和凭据注入之间存在明确的安全权衡。

### 5.3 凭据和环境变量

官方当前文档提供 `sandbox.credentials`，可对特定凭据文件和环境变量执行 deny 或 mask。

但源码快照中与当前文档存在版本差异，因此不能假定本地 2026-05-23 快照已经包含全部最新凭据保护能力。

这也说明：

- OS 文件系统沙盒不自动等于凭据隔离；
- 环境变量需要单独处理；
- 网络代理允许携带凭据时，需要更高强度的信任边界。

## 6. 平台支持和降级

### 6.1 平台矩阵

| 平台 | Claude Code 沙盒状态 | 关键限制 |
|---|---|---|
| macOS | 支持 | 使用 Seatbelt，部分系统能力需要额外放行 |
| Linux | 支持 | 需要 bubblewrap、socat 等依赖 |
| WSL2 | 支持 | 使用 Linux/bubblewrap；不能调用 Windows 程序 |
| WSL1 | 不支持 | 缺少 bubblewrap 所需内核能力 |
| 原生 Windows | 不支持 | 官方建议使用 WSL2 |

### 6.2 普通降级

默认情况下，如果沙盒不可用，Claude Code 会给出警告，然后运行普通权限流程。

如果某条命令因为沙盒限制失败，Claude Code 也可以在分析失败原因后使用 `dangerouslyDisableSandbox` 重试。重试后的命令不再拥有 OS 沙盒保护，而是回到普通权限系统。

### 6.3 严格模式

Claude Code 提供两个关键收紧开关：

- `failIfUnavailable: true`：沙盒依赖或平台不满足时直接失败；
- `allowUnsandboxedCommands: false`：禁止通过 `dangerouslyDisableSandbox` 绕过沙盒。

这两个开关说明 Claude Code 同时支持两种产品目标：

- 默认模式：优先任务完成率，沙盒不可用时允许降级；
- 严格模式：沙盒是安全门槛，不可用就停止执行。

## 7. Claude Code 的真实安全边界和局限

### 7.1 沙盒只覆盖 Bash

Read、Write、Edit、Glob、Grep 等工具在 Claude Code 主进程中执行，不受 Bash OS 沙盒的直接保护。

因此，Claude Code 的 Bash 沙盒不能防止其他工具：

- 读取主进程可访问的敏感文件；
- 修改 Claude Code 自身配置；
- 修改会影响后续会话的规则文件。

这是 Claude Code 当前架构的明确局限。

### 7.2 `excludedCommands` 是受控逃生口

`excludedCommands` 可以让某些命令在沙盒外执行，例如 Docker、某些宿主机工具或与沙盒不兼容的命令。

它提高了兼容性，但降低了统一安全边界。Claude Code 源码明确将其定义为便利配置，而不是安全控制。

### 7.3 沙盒不是完整隔离环境

官方文档明确提醒：

- 宽泛的域名 allowlist 可能导致数据外泄；
- Unix socket，尤其是 Docker socket，可能成为主机逃逸通道；
- 过宽的写目录可能导致配置、Shell 初始化文件或可执行文件被污染；
- Linux 弱化嵌套沙盒会显著降低安全性；
- macOS 放开 Apple Events 后，沙盒命令可能启动沙盒外的应用。

所以 Claude Code 的沙盒是“降低风险的 OS 级执行边界”，不是虚拟机级的绝对隔离。

## 8. 与 MyAgent 当前实现的对比

| 维度 | Claude Code | MyAgent 当前实现 |
|---|---|---|
| 工具拆分 | 主要围绕 Bash 设计，PowerShell 是辅助 provider | 已拆分为 Bash 和 PowerShell 两个模型可见工具 |
| 原生 Windows 沙盒 | 不支持 | 当前运行在原生 Windows |
| 复合命令 | 允许进入 Shell 解析和权限流程 | `terminal-guard.ts` 直接拒绝复合符号 |
| 复合命令权限 | 完整命令和各子命令分别检查 | 当前更偏向单条命令整体判断 |
| 安全解析 | Bash parser、语义安全检查、危险模式检查 | Shell family 分发、正则和白名单检查 |
| 文件系统隔离 | OS 级，默认限制写入范围 | cwd 范围校验，缺少进程级文件系统隔离 |
| 网络隔离 | 沙盒代理和域名 allowlist | 当前没有进程级网络沙盒 |
| 子进程边界 | Bash 子进程继承 OS 沙盒 | 当前主要依靠进程引擎的生命周期控制 |
| 沙盒不可用 | 默认警告并降级，也支持严格失败 | 当前不存在同等的 OS 沙盒能力协商 |
| 非沙盒逃生口 | `excludedCommands` 和 `dangerouslyDisableSandbox` | 当前没有对应的沙盒逃生模型 |

MyAgent 当前最明显的问题不是“缺少一个 `sandbox` 布尔字段”，而是：

1. 把复合语法直接当成危险边界；
2. 把 cwd 限制误当成进程文件系统隔离；
3. 没有把权限决策、实际执行边界和降级状态统一建模；
4. 没有明确区分“沙盒不可用”“命令被权限拒绝”和“命令在沙盒中运行失败”。

## 9. 对阶段 2 的修正结论

目前不能直接采用“给 Bash 和 PowerShell 都加统一沙盒，然后全面放开复合命令”的方案，因为这不是 Claude Code 的真实做法，尤其不适用于原生 Windows PowerShell。

阶段 2 在继续规划前，必须先做出以下选择：

### 选择 A：复刻 Claude Code

- 只为 Bash 建立 OS 级沙盒；
- 在 Windows 上要求 WSL2；
- PowerShell 不进入 Claude 风格沙盒；
- 复合命令进入解析和权限流程；
- 保留显式 deny / ask 和危险语义检查；
- 支持普通降级和严格沙盒模式。

### 选择 B：支持原生 Windows PowerShell 的自有沙盒

- 需要单独研究 Windows AppContainer、受限令牌、Job Object、网络隔离等机制；
- 不能简单把 Job Object 或 cwd 限制称为完整沙盒；
- 这是 MyAgent 的扩展设计，不应继续声称是 Claude Code 方案；
- 实现成本和发布复杂度都会明显高于复刻 Bash/WSL2 方案。

### 选择 C：先做应用层执行边界

- 允许复合命令；
- 继续保留权限和危险语义检查；
- 增加 cwd、环境变量、进程树、输出和超时控制；
- 明确声明这不是 OS 级沙盒；
- 后续再替换为真实平台沙盒。

这三种方案不能混为一谈。特别是选择 C 可以作为工程过渡，但不能把它包装成 Claude Code 同等级的安全能力。

## 10. 当前不应做的事情

在上述选择确定前，暂不应：

- 直接删除 MyAgent 的复合命令拒绝逻辑；
- 将 PowerShell 也标记为已具备沙盒保护；
- 把 `cwd` 限制改名为 OS 沙盒；
- 用 Job Object 代替文件系统和网络隔离；
- 因为命令在沙盒内就跳过显式 deny / ask；
- 把 `excludedCommands` 设计成安全白名单；
- 默认继承所有环境变量和凭据；
- 在沙盒不可用时静默降级而不记录状态。

## 11. 参考资料

- [Claude Code 官方 Bash 沙盒文档](https://code.claude.com/docs/en/sandboxing)
- [Anthropic Sandbox Runtime 官方仓库](https://github.com/anthropic-experimental/sandbox-runtime)
- [Claude Code 官方仓库](https://github.com/anthropics/claude-code)
- [Claude Code Bash-only 沙盒范围讨论](https://github.com/anthropics/claude-code/issues/26616)
- 本地 Claude Code 源码快照：`D:\projects\Agents\claude-code-analysis\src`
- 本地 Claude Code 分析材料：`D:\projects\Agents\claude-code-analysis\analysis\04e-sandbox-implementation.md`

## 12. 其他竞品的 Windows 沙盒调研

本节只回答一个问题：其他参考项目是否提供了能够覆盖原生 Windows 子进程（包括 PowerShell 及其后代进程）的真实隔离方案。这里将“原生 Windows 运行兼容性”“工作目录限制”“容器/远程执行”和“宿主机 OS 级沙盒”严格区分。

### 12.1 Codex：原生 Windows 沙盒最完整，但也是最复杂的方案

Codex 当前实现了独立的 Windows 沙盒 crate：`codex-rs/windows-sandbox-rs`。本地源码可以看到它不只是启动一个低权限进程，而是组合了多层机制：

- 受限 token 和 restricting SID，用于限制写入能力；
- ACL，用于给工作区和额外授权路径授予写入能力，并处理 deny-read / deny-write；
- 专用 Windows 沙盒用户，分别服务于离线和联网命令；
- Windows Firewall，用于按沙盒用户阻断网络；
- `codex-command-runner.exe` 和 `codex-windows-sandbox-setup.exe` 等专用辅助进程；
- DPAPI 保存沙盒用户凭据；
- 子进程从受限 token 启动，因此 PowerShell、Git、Python 和它们继续创建的进程都在同一权限边界内。

OpenAI 的工程说明明确指出，Windows 没有直接等价于 macOS Seatbelt 或 Linux bubblewrap 的现成能力，因此 Codex 最终采用了“专用用户 + 受限 token + ACL + 防火墙”的组合，并接受一次管理员配置和较高系统复杂度的代价。它还明确否定了单独依赖 AppContainer、Windows Sandbox 和低完整性标签作为最终方案：前者对开放式开发工作流形状不合适，后两者会带来兼容性或宿主文件信任属性问题。

需要客观看待它的缺点：

- 初始化和刷新可能需要管理员权限、创建本地用户、修改 ACL 和安装防火墙规则；
- Windows ACL、受限 token 的“双重权限检查”、原子替换、`--add-dir` 和系统目录访问都存在复杂边界；
- 额外路径必须同步完成策略和 ACL 授权，否则“应用层允许”仍可能被 OS 拒绝；
- 网络能力与凭据注入不是免费能力，需要单独建模、配置和排错。

结论：Codex 证明了原生 Windows PowerShell 沙盒是可做的，但它不是一个轻量的 TypeScript wrapper，也不是“给进程加 Job Object”这么简单。它更像一个 Windows 安全运行时和安装/升级系统。

参考：

- [Codex Windows 沙盒工程说明](https://openai.com/index/building-codex-windows-sandbox/)
- [Codex Windows 沙盒源码入口](<D:\projects\Agents\codex\codex-rs\windows-sandbox-rs\src\lib.rs>)
- [Codex Windows 沙盒运行实现](<D:\projects\Agents\codex\codex-rs\windows-sandbox-rs\src\lib.rs>)
- [Codex Windows 沙盒 crate 文件列表](<D:\projects\Agents\codex\codex-rs\windows-sandbox-rs>)

### 12.2 Gemini CLI：原生 Windows 沙盒可读性更强，但副作用更直接

Gemini CLI 在 `packages/core/src/sandbox/windows` 中提供了专门的 Windows 实现，核心文件包括 `WindowsSandboxManager.ts` 和 `GeminiSandbox.cs`。它的执行链路是：

1. Node 侧根据 workspace、显式授权路径、禁止路径和检测到的 secret 文件生成 manifest；
2. 启动 `GeminiSandbox.exe`，而不是直接启动 PowerShell；
3. C# helper 创建受限 token，并把 token 完整性级别降为 Low；
4. 创建 Job Object，设置子进程树的生命周期约束；
5. 对 manifest 中的路径应用 ACL 和低完整性标签；
6. 用 `CreateProcessAsUser` 启动目标命令，因此目标 PowerShell 和后代进程继承该 token 与 Job Object。

这是真正的原生 Windows 进程级方案，不是 cwd 检查。它的优势是结构相对集中，Node/原生 helper 的职责边界清楚，并且支持 `__read`、`__write` 等内部文件操作路径。

但它也有不能忽略的限制：

- 低完整性标签和 ACL 会修改真实宿主文件系统的安全属性，不是临时的纯进程状态；
- deny/allow manifest 的正确性高度依赖路径解析、符号链接、UNC 路径、已存在路径和继承规则；
- 对不存在的额外写入路径，源码会拒绝授权，避免通过父目录推导出过大的权限；
- 网络关闭在 helper 中使用 Job Object 的网络限速能力，失败时会输出 warning，不能简单等价于成熟的按进程防火墙；
- 源码中还保留了命令安全判断和 sandbox denial 解析，因此它并没有因为存在 OS 沙盒就完全放弃应用层策略。

结论：Gemini 是最值得研究的“较小规模原生 Windows 方案”样本，但不能只复制 `GeminiSandbox.cs` 的 token、Job Object 和 ACL 片段。必须连同 setup、manifest、路径解析、恢复/清理、失败诊断和测试一起评估，否则很容易留下持久 ACL 污染或授权绕过问题。

参考：

- [Gemini CLI 沙盒官方文档](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/sandbox.md)
- [Gemini WindowsSandboxManager.ts](<D:\projects\Agents\gemini-cli\packages\core\src\sandbox\windows\WindowsSandboxManager.ts>)
- [Gemini GeminiSandbox.cs](<D:\projects\Agents\gemini-cli\packages\core\src\sandbox\windows\GeminiSandbox.cs>)
- [Gemini Windows 沙盒测试](<D:\projects\Agents\gemini-cli\packages\core\src\sandbox\windows\WindowsSandboxManager.test.ts>)

### 12.3 Hermes Agent：用执行后端隔离，不实现原生 Windows PowerShell 沙盒

Hermes 的安全文档把 OS 级隔离定义为真正的安全边界，并把执行目标抽象为 terminal backend：

- `local`：直接运行在宿主机，无隔离；
- `docker`：命令、文件工具和 `execute_code` 进入 Docker 容器；
- `ssh`：进入远程主机；
- `modal`、`daytona`：进入云沙盒；
- `singularity`：进入容器。

Hermes 的原生 Windows 文档主要解决 Windows 运行兼容性：通过 Git Bash 执行终端命令，而不是构建 PowerShell 的 OS 沙盒。也就是说，Windows 原生模式能运行 Hermes，但其 local backend 仍然是宿主机权限；要获得隔离，需要 Docker、WSL、远程或云执行后端。

这是一个重要的架构选择：Hermes 没有把“原生 Windows 沙盒”塞进主进程，而是把安全边界外移到执行环境。代价是用户必须接受容器/远程环境的工具差异、路径映射和凭据注入问题。

参考：

- [Hermes 安全策略](<D:\projects\Agents\hermes-agent\SECURITY.md>)
- [Hermes Windows 原生指南](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/windows-native.md)
- [Hermes terminal backend 配置](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/configuration.md)

### 12.4 OpenClaw：把所有工具执行搬进后端沙盒

OpenClaw 的 sandbox 不是 PowerShell 进程沙盒，而是工具执行后端：`exec`、`read`、`write`、`edit`、`apply_patch`、`process` 等工具一起进入 Docker、SSH 或 OpenShell。Docker 默认关闭网络、只读 root filesystem、丢弃 capabilities，并通过 bind mount 显式暴露 workspace 或额外目录。

它的优点是边界清楚：不只限制 shell，文件工具也走同一执行环境；它还提供 sandbox mode、scope、workspaceAccess、bind 校验、recreate 和 explain 等运维能力。缺点也同样清楚：Gateway 仍在宿主机，elevated tool 可以显式绕出 sandbox；Windows 上使用 Docker Desktop 时，本质仍是 Linux 容器/虚拟化后端，而不是原生 Windows PowerShell 子进程沙盒。

结论：OpenClaw 值得借鉴的是“统一执行后端”和“解释/重建/逃生口显式化”，不适合作为 Windows 原生 token 沙盒的实现样本。

参考：

- [OpenClaw sandboxing 设计文档](<D:\projects\Agents\openclaw\docs\gateway\sandboxing.md>)
- [OpenClaw sandbox CLI](<D:\projects\Agents\openclaw\docs\cli\sandbox.md>)
- [OpenClaw Docker sandbox backend](<D:\projects\Agents\openclaw\src\agents\sandbox\docker-backend.ts>)

### 12.5 OpenCode：明确不提供沙盒

OpenCode 的 `SECURITY.md` 直接声明 permission system 只是 UX 提示，不是安全隔离；需要真正隔离时应把 OpenCode 放在 Docker 容器或 VM 内。它支持 Windows 发布和运行，并不代表它提供了 Windows PowerShell 沙盒。

这反而是一个有价值的负面样本：如果项目没有 OS 边界，就不应通过“权限确认”“cwd 限制”或“命令正则”暗示自己具备沙盒能力。

参考：[OpenCode SECURITY.md](<D:\projects\Agents\opencode\SECURITY.md>)。

### 12.6 TinyPace AI Desktop：复用 Hermes，不是独立方案

TinyPace 的源码主要负责 Electron/桌面集成，并启动 Hermes Agent；检索到的 Docker 相关内容主要是 MCP 或脚本配置，没有发现独立的 Windows sandbox manager、restricted token、AppContainer、Job Object 或 PowerShell 执行隔离实现。因此它不能作为新的 Windows 原生沙盒竞品样本。

参考：[TinyPace Hermes 启动集成](<D:\projects\Agents\tinypace-ai-desktop\electron\services\AIChatService.ts>)。

## 13. 竞品对比后的阶段 2 结论

| 项目 | 原生 Windows 沙盒 | PowerShell 子进程边界 | 主要机制 | 主要代价 |
|---|---:|---:|---|---|
| Claude Code | 否 | 不适用 | macOS Seatbelt / Linux bubblewrap / WSL2 | Windows 需要 WSL2，不能直接保护原生 PowerShell |
| Codex | 是 | 是 | 专用用户、restricted token、ACL、Firewall、辅助进程 | 管理员 setup、复杂安装和 ACL/网络故障面 |
| Gemini CLI | 是 | 是 | restricted token、Low integrity、Job Object、ACL manifest、C# helper | 持久修改文件安全属性、路径和恢复逻辑复杂 |
| Hermes | 否 | 通过容器/远程后端间接实现 | Docker、SSH、Modal、Daytona、Singularity | 工具环境和宿主环境分离，不能直接使用原生 PowerShell 环境 |
| OpenClaw | 否 | 通过 Docker/SSH/OpenShell 间接实现 | 统一 sandbox backend | Windows 依赖 Docker/远程环境，Gateway 仍在宿主机 |
| OpenCode | 否 | 否 | permission UX，无 OS sandbox | 必须由用户自行提供 Docker/VM 边界 |
| TinyPace | 未发现 | 未发现 | 复用 Hermes | 没有独立执行隔离实现 |

由此可以修正此前的判断：原生 Windows PowerShell 沙盒并非“不可能”，Codex 和 Gemini 都已经证明可行；但这两个方案也共同证明，它不是普通应用层重构的一个小阶段，而是平台安全运行时项目。

### 13.1 对 MyAgent 的推荐

推荐采用“两级执行后端”路线，而不是立即复制 Codex 的完整 Windows 安全运行时：

1. 先把应用层执行模型改成允许复合命令，并保留完整命令/子命令权限检查、危险语义检查、超时、进程树终止和明确的失败状态；这一步只能称为应用层执行边界。
2. 增加可选的 Docker/WSL2 sandbox backend，优先覆盖 Bash 和需要 POSIX 工具链的任务；这条路线吸收 Claude、Hermes、OpenClaw 的共同经验，能较快获得真正 OS/容器边界。
3. 原生 Windows PowerShell 沙盒单独作为后续平台项目立项，先做 Codex/Gemini 方案的威胁模型和最小实验，不把它混入“放开复合命令”的小改动中。
4. 如果最终必须支持原生 PowerShell，优先研究 Codex 的“专用用户 + restricted token + ACL + Firewall”路线；把 Gemini 的 Low integrity 方案作为对照和实验样本，而不是默认生产方案。

推荐的原因不是 Codex 代码更复杂，而是它的工程结论更诚实：它明确记录了 AppContainer、Windows Sandbox、Low integrity、ACL、Firewall 和权限继承各自解决不了什么问题。MyAgent 若要达到同一安全承诺，必须承担相近的 setup、升级、修复和测试成本。

### 13.2 当前不要得出的错误结论

- “Gemini 能做，所以 MyAgent 加一个 C# helper 就完成了。”错误，遗漏了 token、ACL、路径、恢复、网络和 setup 生命周期。
- “Codex 使用 Windows restricted token，所以只要 restricted token 就够了。”错误，Codex 的网络边界依赖独立用户和防火墙，文件边界还依赖 ACL 与权限解析。
- “Docker 在 Windows 上可用，所以这就是原生 PowerShell 沙盒。”错误，Docker Desktop 通常提供的是 Linux 容器/虚拟化执行环境。
- “cwd 校验和复合命令解析已经等价于沙盒。”错误，它们仍然属于应用层策略。
- “存在 OS 沙盒后就可以取消权限检查。”错误，Claude、Codex、Gemini 和 OpenClaw 都保留了不同层次的权限/策略控制。
