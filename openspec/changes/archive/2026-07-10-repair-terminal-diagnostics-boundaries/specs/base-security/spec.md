## MODIFIED Requirements

### Requirement: 终端写倾向命令拦截与安全降级

在终端命令 `execute_command` 拦截过程中，系统必须（MUST）通过敏感命令及常见别名正则审查输入命令。除了明确安全的只读白名单指令（如 `git status`、`git diff`）外，凡是包含写倾向、管道混写或未识别的复杂脚本，系统应当（SHALL）将其安全级别降级为 `behavior: 'ask'` 并挂起执行，拉起交互弹窗提问，不得静默放行。在 `Plan` 模式下，系统必须（MUST）将可进入审批的终端命令集合限定为**可静态证明安全的系统只读查询**：即该命令必须同时满足（1）命中只读白名单前缀、且（2）不包含任何复合连接符（`|`、`&`、`;`）、重定向符（`>`、`<`）、环境变量展开符（`%`）或命令替换语法（`$(`、`` ` ``）。满足上述条件的命令在 Plan 模式下应当（SHALL）进入统一审批流程；不满足的命令必须（MUST）予以硬拦截并返回 `BLOCKED (Plan Mode Only)` 错误，且错误消息中必须（MUST）附带针对大模型的引导性自愈提示，告知其应改用何种只读原生工具（如 `list_dir` / `read_file` 等）或指示其将高危改动在计划中进行合理表述。前置安全判定与执行期结构校验必须在允许集合上严格同构。

#### 场景: Plan 模式下可静态证明安全的只读命令进入审批

- **WHEN** 智能体在 `Plan` 模式下试图在终端执行只读白名单内且无复合符号的系统查询命令 `dir /-C /w C:\Windows\Temp`
- **THEN** 拦截器判定该命令同时满足白名单匹配和无复合字符两个条件，识别为可静态证明安全的只读查询，并将其送入统一审批流程。

#### 场景: Plan 模式下受限磁盘容量查询进入审批

- **WHEN** 智能体在 `Plan` 模式下以 `shellKind: "cmd"` 执行 `wmic logicaldisk where "DeviceID='C:'" get Size,FreeSpace /format:value`
- **THEN** 拦截器必须将其识别为受限的只读磁盘容量查询，且在通过结构安全校验后进入统一审批流程。

#### 场景: Plan 模式下非目标 wmic 查询仍被拦截

- **WHEN** 智能体在 `Plan` 模式下以 `shellKind: "cmd"` 执行 `wmic process list` 或其他非 `wmic logicaldisk` 前缀的命令
- **THEN** 拦截器必须返回 `BLOCKED (Plan Mode Only)`，不得因 `wmic logicaldisk` 白名单扩展而放行任意 WMI 查询。

#### 场景: Plan 模式下含复合符号的命令被直接拒绝

- **WHEN** 智能体在 `Plan` 模式下试图在终端执行 `dir /-C /w C:\Windows\Temp 2>nul | find "文件"`
- **THEN** 拦截器判定该命令虽命中只读白名单但因包含复合连接符 `|` 和重定向符 `>`，与执行期结构校验同构判定为不安全，直接返回 `BLOCKED (Plan Mode Only)` 并附带自愈引导提示。
