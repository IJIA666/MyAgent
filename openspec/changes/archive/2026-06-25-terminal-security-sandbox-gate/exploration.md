# 探索主题: 终端安全网关命令注入防范与 Git 写指令强力拦截机制

## 1. 问题定义
在当前的 `my-simple-agent` 项目中，终端执行安全防护网关 `terminal-guard.ts` 存在两个严重的安全隐患：
1. **复合拼接命令注入逃逸**：用于拦截复合命令的正则表达式 `COMPOSITE_REGEX = /[&|<>^%\r\n]/` 遗漏了分号 `;` 与反引号 `` ` ``，同时没有针对 `$()`、`${}` 命令替换符号进行限制。在类 Unix、Git Bash 或支持分号语句分隔的环境中，攻击者/大模型能够轻易通过 `command1 ; command2` 或反引号执行任意嵌套注入指令。
2. **Git 写/变更操作缺乏强力阻断**：按照“严禁执行除查看外的任何 Git 操作，仅允许 git status、git log、git diff 等只读查看命令”的安全红线规范，当前的网关机制只是把除白名单外的所有 Git 操作（如 `git commit`, `git add`）降级为 `ask`（人工确认状态）。在 YOLO 模式下它们会被直接通过，在 Auto 模式下一旦用户误确认也会被执行，缺乏在安全网关底盘上的强行绝对阻断。

## 2. 关键发现与调研结果
- **代码库现状与调用链职责分析**：
  1. `src/adapters/tools/tools/system/terminal.ts` 的 `checkSafety` 依赖 `isHardlineDangerous` 识别绝对黑名单命令（如 `rm -rf /` 等直接拒绝且 YOLO 模式不豁免），并通过 `checkCommandSafetyLevel` 进行写动作别名判定。
  2. 目前 Git 的安全阻断仅依赖 `READONLY_COMMAND_WHITELIST` 只读白名单，未被白名单匹配的 `git commit` 等写指令在 `checkCommandSafetyLevel` 中被降级为 `'ask'`。如果在 `YOLO` 模式下直接调用，或者在 `Auto` 模式下人工批准，便可正常执行，这打破了 Git 只读的安全底线约束。
  3. `terminal-guard.ts` 的 `COMPOSITE_REGEX` 仅包含了 `&|<>^%\r\n`，并没有阻止分号 `;`，也没有阻止反引号 `` ` ``，导致在 PowerShell 或 Bash 下利用 `;` 拼接的第二条指令能够完全绕过 `validateCommand` 校验并执行。
  4. **职责分层盲区与接口契约权衡：**
     在现有实现中，`validateCommand(command)` 接收原始完整命令行（包含嵌套外壳，如 `powershell -Command "..."`）。若直接在 `validateCommand` 外强制要求传入解包后的命令，会造成破环性的接口语义变更，导致外部调用方（如测试用例或未来新增的适配器）因遗漏 `unboxNestedCommand` 而引入新的绕过隐患。

  **防御性内部剥壳与网关调用链设计**：
  为保持接口的一致性，`validateCommand(command)` 维持原有的函数签名与外部契约（即接收原始完整指令并负责安全过滤），但在其内部实现中第一步**自动调用 `unboxNestedCommand(command)` 进行防御性剥壳**，对解包后的核心命令进行引号感知的拼接与注入检测。
  
  ```mermaid
  graph TD
      Raw[原始命令 command]
      Raw --> |传入安全校验| Guard[validateCommand 校验入口]
      Guard --> |内部自动调用| Unbox[unboxNestedCommand 防御性剥壳]
      Unbox --> |提取核心内容| Unboxed[解包后的核心命令 unboxedCmd]
      
      Unboxed --> |引号感知过滤| QuoteFilter{是否包含非包裹的分号/反引号/拼接符?}
      QuoteFilter --> |是| Deny[抛出异常 拒绝执行]
      QuoteFilter --> |否| PathCheck[validateCwd 沙箱校验]
      
      PathCheck --> Pass[执行底座 runCommandEngine]
  ```

- **核实与洞察**：
  1. **Claude Code 竞品分析**：在 `claude-code-analysis` 的 `bashSecurity.ts` 中，对 `git commit` 有着极其细致的 `validateGitCommit` 过滤（在 early allow 阶段只允许简单的、无注入模式的 commit message，而对任何带有 `\`、`$()`、`|`、`&` 等字符的提交信息进行强力拦截以防 command injection）；并且对 shell 命令行中的 `$()` 命令替换进行绝对拦截。
  2. **分词 Bug 与防逃逸**：竞品中揭示了 `shell-quote` 的 `shellQuoteSingleQuoteBug`（在单引号内错误识别反斜杠为转义，导致后面拼合的恶意 payload 逃出检测）。我们如果要过滤敏感字符，必须在保证引号内字符被正确归属的前提下进行。

## 3. 方案对比与推荐方向

| 评估维度 | 方案 A (现有方案) | 方案 B (增强正则 + 内部防御性剥壳 + 绝对 Git 黑名单) | 方案 C (引入 Tree-sitter 复杂 AST 解析) |
| :--- | :--- | :--- | :--- |
| **漏洞防注入性** | 弱 ✗ (分号与反引号可绕过) | 强 ✓ (修复正则并防范命令替换) | 极强 ✓ (解析完整语法树) |
| **Git 限制合规度** | 弱 ✗ (通过 YOLO/用户确认可突破) | 极强 ✓ (全模式绝对阻断任何非只读 Git 命令) | 极强 ✓ |
| **依赖与运行开销** | 极低 ✓ | 极低 ✓ | 高 ✗ (需安装并编译原生 C/C++ 依赖) |
| **跨平台环境兼容性** | 高 ✓ | 高 ✓ | 差 ✗ (在无编译环境的 Windows 下易报错) |

**推荐路径**：
选择**方案 B**。虽然方案 C（AST）最完美，但在 Windows 等轻量级开发环境下编译 Tree-sitter 会带来极重的环境负担，且容易产生安装失败。方案 B 可以在极简助手的体量下提供最高性价比的安全护栏。

**方案 B 具体实施步骤**：
1. **重塑复合拦截正则**：将 `COMPOSITE_REGEX` 升级为 `/[;&|<>^%`\r\n]|\\\(|\$\(/`，封堵分号 `;`、反引号 `` ` ``、以及 `$(` 与 `\(` 的命令替换注入路径。
2. **防范引号误杀设计（`validateCommand` 内部逻辑）**：
   - 接收原始 `command` 后，在内部调用 `unboxNestedCommand(command)` 取得 `unboxedCmd`。
   - 对 `unboxedCmd` 进行遍历扫描。如遇到非引号（单/双/反引号）包裹的 `COMPOSITE_REGEX` 匹配符，立刻阻断并抛出异常。
   - 这能有效兼顾 `grep "a;b"` 等引号内分号的安全放行，同时对 unquoted 分号和注入外壳中的分号实行物理拦截。
3. **底盘阻断非只读 Git 指令**：
   - 建立非只读 Git 写的绝对阻断正则：`DANGEROUS_GIT_WRITE_REGEX`，匹配 `add`, `commit`, `checkout`, `reset`, `push`, `pull`, `rebase`, `merge`, `stash`, `revert` 等所有可能改写或拉取仓库的代码变更操作。
   - 在 `isHardlineDangerous` 绝对黑名单中引入对非只读 Git 命令的拦截。一旦 `unboxNestedCommand(command)` 解包出的指令以 `git` 开头，且匹配到了任何 Git 写操作子命令，则立即判为 `true`。
   - 这确保了即使是在 YOLO 模式下，或者在 Auto 模式人工审批时，也绝对无法执行非只读 Git 操作，直接拒之门外。

## 4. 约束、风险与未知项
- **PowerShell 平台差异与 `$(` 误杀权衡**：
  在 Windows 平台上，PowerShell 使用 `$(` 作为变量子表达式访问语法（例如 `$($env:TEMP)`）。直接对其进行绝对拦截确实会存在限制模型直接执行此类 PowerShell 脚本特征命令的副作用。
  
  **安全抉择与规避机制**：
  鉴于 `$(` 在 PowerShell 和 Unix Bash 中均属于命令替换（如 `echo $(whoami)`）的极高危漏洞利用媒介，出于“安全第一”的设计决策，安全网关将一视同仁予以绝对阻断。如果模型需要执行含有复杂变量或多语句的 PowerShell 逻辑，网关应引导其**先将命令逻辑落盘为 `.ps1` 脚本文件**，随后通过文件直接调用（此操作将触发 checkSafety 降级为 ask 由用户在系统层整体把关），以此在安全与实用性中取得平衡。
- **引号语义拆解**：有些复杂的命令会采用嵌套双引号和单引号（如 `node -e "console.log('hello; world')"`），我们剥离引号的解析器必须能处理多重转义和嵌套，避免误报阻碍正常开发。
- **只读 Git 命令的动态需求**：未来可能有一些原本是只读但看起来属于写操作的命令（例如 `git checkout -- <file>` 用来回滚文件），需要确定是否一概封杀。按照目前的 user_global 红线，应该一概封杀并提示用户在自己的终端中手动执行。

## 5. 否决方案
- **完全依赖 Tree-sitter / node-tree-sitter-bash**：由于需要 node-gyp 编译并在目标 Windows系统上依赖 VC++ Build Tools 编译环境，对于一个旨在“通用极简”的智能体应用而言，这一依赖会导致不可控的环境搭建失败率，故坚决予以否决。
