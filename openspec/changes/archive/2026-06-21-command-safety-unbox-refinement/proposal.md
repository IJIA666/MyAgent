## 改造原因

当前系统的终端命令安全校验存在以下亟待解决的痛点：
1. **硬编码白名单的黑盒问题**：原有 `READONLY_COMMAND_WHITELIST` 只读放行规则属于硬编码，用户无法根据实际工程环境自定义修改，缺乏透明度与掌控度。
2. **Windows 环境下的兼容性与摩擦力**：在 Windows 环境中，Agent 倾向于使用 `powershell` 或 `cmd` 包裹执行命令。如果在底层直接拦截解释器前缀，将导致 `spawn(shell: false)` 执行原生命令时抛出 `ENOENT` 错误（Windows 操作系统物理屏障）；若不拦截，则用户在每次执行解释器包裹的命令时都必须手动审批，摩擦力极大。

因此，亟需引入一种“解包剥壳校验（Unbox）”的优化方案。允许使用解释器外壳执行命令以解决兼容性，但在核查与前缀提取时剥离外壳，比对实际内核指令；同时将硬编码白名单解耦为本地可配置 JSON 文件，并在审批挂起时融入告知机制，从而保障 Windows 底层兼容性、消除用户操作摩擦并确保高健壮性安全防线。

## 变更内容

1. **废弃硬编码，改用显式预设初始化**：完全废弃 `READONLY_COMMAND_WHITELIST`，改用工作区下本地可见且可配置的 `.agent/allowed_commands.json`。在文件缺失或为空时，系统自动在本地写入一份包含 `git status:*` 等在内的常用安全规则作为初始化预设。
2. **解包剥壳校验（Unbox）机制**：在提取安全前缀（`extractSafePrefix`）与安全审查匹配（`checkSafety`）中，对命令行均先进行解包剥壳（`unboxNestedCommand`），还原出内核实际命令进行后续提取和比对。
3. **算法健壮性升级**：
   * **切片解包**：优化 `shellPrefixPattern` 正则以匹配并忽略解释器与 `-Command` 之间的其他 CLI 参数选项（如 `-ExecutionPolicy Bypass`），随后通过 slice 截取剩余文本，防止因内层命令嵌套单/双/反引号而发生正则捕获截断。
   * **首尾引号闭合扫描**：引入 `getMatchingQuoteIndex` 引号闭合点扫描机制。仅在首尾引号被判定为同一对包围整个命令的引号时才进行剥除，防止如 `"cmd A" --arg "cmd B"` 类型的多引号结构被误解构。
   * **精确 PowerShell 脚本块识别**：通过正则匹配 `^&\s*\{`，确保仅对 `& { ... }` 脚本块进行花括号剥除，不误伤普通带花括号选项参数的命令。
4. **融合知情告知机制**：在挂起（`suspend`）状态的审批提示信息中，如果解包后的实际内核指令与原始包裹命令不同，将在 message 中显式披露解包后的“实际核心指令”，为用户提供透明的决策依据。

## 业务能力

### 新增业务能力
- 无

### 修改业务能力
- `security-modes`: 修改已有的安全工作模式校验与白名单匹配规则，引入剥壳机制与本地 JSON 白名单持久化初始化。

## 影响范围

* **受影响代码文件**：
  * `src/adapters/tools/tools/system/terminal-guard.ts`：更新解包剥壳函数（`unboxNestedCommand`）以引入非正则切片定位、闭合引号匹配点算法、精准脚本块识别，并废弃 `READONLY_COMMAND_WHITELIST`。
  * `src/adapters/tools/tools/system/terminal-config.ts`：在 `loadAllowedCommands` 中写入本地 JSON 初始化，并在 `extractSafePrefix` 提取前缀前进行剥壳。
  * `src/adapters/tools/tools/system/terminal.ts`：修改 `checkSafety` 的白名单校验，引入剥壳匹配；当 `needApproval` 挂起时，更新返回 message 以包含实际核心执行指令。
* **受影响单元测试**：
  * `test/action/terminal.test.ts`：需更新和补充针对剥壳、引号识别、脚本块清洗以及本地 JSON 读写的测试。
