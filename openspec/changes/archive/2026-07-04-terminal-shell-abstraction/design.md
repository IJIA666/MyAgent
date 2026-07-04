## 背景

当前终端执行子系统由四个模块协作完成一条命令的生命周期：`terminal.ts`（工具入口）→ `terminal-guard.ts`（安全解析）→ `terminal-config.ts`（配置/白名单）→ `terminal-engine.ts`（进程执行）。这四个模块均已被平台特化逻辑渗透：

- **Guard 层**：`unboxNestedCommand()` 已能识别 `sh|bash|cmd|powershell|pwsh` 的 `-c`/`-Command`/`/c` 包装模式，`DANGEROUS_WRITE_COMMAND_REGEX` 显式列举 PowerShell 写操作别名，`READONLY_COMMAND_WHITELIST` 混入 `dir`（Windows）和 `ls`（POSIX）
- **Engine 层**：`spawn` 调用固定 `shell: false`，且包含三条仅 `process.platform === 'win32'` 的分支——npm `.cmd` 重定向、PowerShell 编码注入、`taskkill` 强杀进程树
- **Config 层**：仅管理 `WorkMode` 与命令白名单，不感知 shell family
- **Policy 层**：`ApprovalPolicy.isHardlineCommand()` 已接纳 `bash` 与 `powershell` 名称，但工具层只注册了 `execute_command`

随着 Linux 适配需求的临近，这种"隐式平台推断 + 特化分支散落"的架构不再可持续。本次设计引入 `ShellExecutionPlan` 中间层，将平台差异收敛至受控抽象中。

## 目标与非目标

**目标:**

- 定义 `ShellKind` 枚举（`auto | posix | powershell | cmd`）作为平台语义的受控入口
- 定义 `ShellExecutionPlan` 接口，统一收口"默认值选择 → 命令归一化 → 安全解析模式 → `exe + argv` 生成"
- 重构 `terminal-guard.ts`，使安全解析按 `shellKind` 语义执行，消除当前隐式混合推断
- 重构 `terminal-engine.ts`，将 Windows 特化分支迁入对应 shell family 的执行计划中
- 扩展 `terminal-config.ts`，增加默认 shell family 与平台感知的默认值选择
- 对齐 `ApprovalPolicy.ts`，消除"策略层已接纳多壳但工具层未注册"的不一致性
- 保留 `execute_command` 作为唯一对外工具，`shellKind` 为可选参数，默认 `auto` 保持向后兼容

**非目标:**

- 不暴露多个顶层工具（`bash`/`powershell`/`cmd`）给模型
- 不实现完整的 Linux 终端支持（仅铺设抽象层，Linux 的具体适配工作由后续 change 承载）
- 不修改安全策略的核心逻辑（原子化拦截、Git 阻断、沙箱锁死等规则保持不变）
- 不引入隐式的运行时 shell 自动切换（`auto` 仍基于既定平台默认值 + 配置覆盖）；但对显式指定的 shell family，可以做最小可用性检查并在不支持时明确失败

## 架构决策

### 决策 1：`ShellExecutionPlan` 作为纯数据对象（Value Object）

**选择**：`ShellExecutionPlan` 定义为不可变数据接口，由工厂函数根据 `shellKind` + 原始命令 + 配置上下文一次性生成。

**替代方案**：使用 Builder 模式或让 Engine 在执行时动态填充计划。

**原因**：Guard 和 Engine 都需要消费同一个 Plan。如果 Plan 在 Guard 阶段后还能被修改，会引入时序耦合和难以调试的"Plan 不一致"问题。纯数据对象便于序列化、日志追踪和审批展示。

```ts
interface ShellExecutionPlan {
  /** 解析后的 shell 家族 */
  readonly shellKind: ResolvedShellKind; // posix | powershell | cmd (auto 已在此阶段解析为具体值)
  /** 归一化后的核心命令文本（是否保留外层包装由 Plan 工厂统一决议） */
  readonly coreCommand: string;
  /** 执行参数：exe 文件路径 + argv 数组 */
  readonly executable: string;
  readonly argv: string[];
  /** 平台特化选项 */
  readonly platformOptions: PlatformExecutionOptions;
}
```

### 决策 2：`shellKind: auto` 的分辨时机与优先级

**选择**：`auto` 的分辨发生在 `ShellExecutionPlan` 工厂中，优先级为：**显式传入 shellKind > 全局配置默认 shellFamily > 平台编译时常量默认值**（Windows → `powershell`，POSIX → `posix`）。

**替代方案**：在 Guard 层或 Engine 层各自分辨。

**原因**：如果 Guard 和 Engine 各自独立推断 shellKind，当二者推断结果不一致时（例如 Guard 认为命令是 PowerShell 语法，Engine 认为当前环境是 cmd），会导致安全解析与实际执行脱节。在 Plan 工厂中一次性决议，确保 Guard 和 Engine 看到的始终是同一个值。

### 决策 3：Guard 层按 `shellKind` 语义执行命令剥离与安全规则匹配

**选择**：`unboxNestedCommand()` 和 `checkCommandSafetyLevel()` 接受 `shellKind` 参数，按 shell 语义执行差异化处理。

**关键变更**：
- `unboxNestedCommand()` 当前无条件剥离 `sh|bash|cmd|powershell|pwsh` 前缀。引入 `shellKind` 后，若模型显式传入了 shellKind，则**不再依赖自动壳识别来推断语义**；是否保留原始包裹命令或仅保留显式声明的 shell family，由 Plan 工厂统一决议，Guard 只消费该决议结果
- `DANGEROUS_WRITE_COMMAND_REGEX` 当前为 PowerShell 特化。改为按 shellKind 选择对应的危险命令正则表
- `READONLY_COMMAND_WHITELIST` 按 shellKind 分流：posix 使用 `ls`/`cat`/`grep` 等 POSIX 命令，powershell 使用 `dir`/`Get-Content`/`Select-String` 等 PowerShell 命令

**替代方案**：保持 Guard 层不变，在 Plan 层做二次转换。

**原因**：安全网关是第一道防线，如果在 Guard 层不按 shell 语义处理，posix 命令（如 `rm -rf`）可能因正则不匹配而漏过，或合法命令（如 PowerShell 原生命令）被误杀。安全逻辑必须在最外层就拥有完整的 shell 上下文，但不应再自行重复做一遍 shell 推断。

### 决策 4：Engine 层按 Plan 执行，消除 shell 选择分支

**选择**：`runCommandEngine()` 接受 `ShellExecutionPlan` 替代原始 `command: string`。Engine 内部不再做任何 shell 推断，直接消费 Plan 中的 `executable` + `argv` + `platformOptions`。

**当前三条 Windows 条件分支的迁入目标**：
- `npm/npx .cmd 重定向` → `platformOptions.npmRewrite`（由 plan 工厂在 Windows + auto/powershell/cmd 时设置）
- `PowerShell 编码注入` → `platformOptions.encodingBootstrap`（由 plan 工厂在 shellKind=powershell 时预置）
- `taskkill 进程树强杀` → `platformOptions.killCommand`（由 plan 工厂提供平台特定的杀进程命令模板）

**替代方案**：保留 Engine 内部的 shell 选择条件分支，仅通过 `platformOptions` 传递标志位。

**原因**：Engine 的职责应该是"执行进程"，而非"判断用什么 shell 方式执行"。将 shell 选择逻辑前移到 Plan 工厂中，Engine 变为以 Plan 为输入的执行器，测试和调试都更加简单。与进程树终止相关的底层平台差异可以继续封装在独立工具函数中，不要求消灭所有平台分支。

### 决策 5：配置层扩展 - 新增 `defaultShellFamily` 配置项

**选择**：在 `terminal-config.ts` 的 `GlobalState` 接口中增加 `defaultShellFamily: ShellKind` 字段，支持从配置文件和环境变量 `AGENT_DEFAULT_SHELL` 读取；当未配置时，默认值由平台决议逻辑提供。

**替代方案**：硬编码 `auto` 永远等于 PowerShell on Windows。

**原因**：硬编码会限制用户在 Windows 上使用 Git Bash/WSL 的场景。提供配置项让用户显式声明偏好 shell，也给 Linux 部署留出灵活性。

## 风险与权衡

| 风险 | 缓解策略 |
| :--- | :--- |
| `shellKind: auto` 的默认分辨率在 Windows 上指向 `powershell`，但部分用户使用 Git Bash 或 WSL，可能导致现有命令习惯发生变化 | `auto` 的默认值可通过 `AGENT_DEFAULT_SHELL` 环境变量或配置文件覆盖；同时在提示词中向模型说明 `shellKind` 参数语义，并在实现阶段补充回归测试确认可接受差异 |
| `unboxNestedCommand` 的职责从“自行猜壳”转为“消费已决议 shell 语义”后，某些边缘命令（如 `bash -c "..."`）的处理方式可能变化 | 将“是否保留包裹命令”集中到 Plan 工厂决议；未传 `shellKind` 的旧路径在第一阶段保留现有剥壳行为，显式指定时走新路径 |
| `DANGEROUS_WRITE_COMMAND_REGEX` 按 shellKind 分流后，新正则表可能遗漏某些危险命令变体 | 每个 shell family 的正则表使用白名单+黑名单双重策略，posix 侧参考 OpenClaw/OpenCode 的已知危险模式，powershell 侧保留现有正则并做增量补充 |
| `ApprovalPolicy` 中 `isHardlineCommand` 已接纳 `bash`/`powershell` 名称但工具未注册，对齐过程中可能需要调整审批策略的匹配逻辑 | 将 `isHardlineCommand` 改为基于 `execute_command` + 已决议 shell 语义匹配，而非工具名称匹配，消除名称层面不一致 |

## 迁移计划

1. **Phase 1 - 新增类型定义**：在 `terminal-types.ts`（新建文件）中定义 `ShellKind`、`ShellExecutionPlan`、`PlatformExecutionOptions` 等纯类型
2. **Phase 2 - 实现 Plan 工厂**：在 `terminal-plan.ts`（新建文件）中实现 `createShellExecutionPlan(command, shellKind?, config?)` 工厂函数
3. **Phase 3 - 重构 Guard 层**：修改 `terminal-guard.ts`，使 `validateCommand`、`unboxNestedCommand`、`checkCommandSafetyLevel` 等函数接受 `ShellExecutionPlan` 或 `shellKind` 参数
4. **Phase 4 - 重构 Engine 层**：修改 `terminal-engine.ts`，使 `runCommandEngine` 接受 `ShellExecutionPlan`，移除内部平台条件分支
5. **Phase 5 - 扩展 Config 层**：在 `terminal-config.ts` 中增加 shell family 相关配置项
6. **Phase 6 - 更新工具入口与审批对齐**：修改 `terminal.ts` 的 `definition`（增加 `shellKind` 参数）和 `execute` 方法（调用 Plan 工厂），修改 `ApprovalPolicy.ts` 的对齐逻辑
7. **Phase 7 - 提示词同步**：在 [prompts.ts](/D:/projects/MyAgent/src/core/usecases/brain/prompts.ts) 中补充 `shellKind` 参数的语义说明

**回滚策略**：由于 `shellKind` 是可选参数，若出现问题可通过配置将默认 shell family 锁定为某一明确值，或在实现阶段保留旧执行路径开关，以便快速回退到改造前的隐式行为。

## 待确认问题

1. `shellKind: auto` 在 Windows 上默认解析为 `powershell` 还是优先检测用户环境中可用的 shell（如 Git Bash 优先于 PowerShell）？需要确认是否有遍历 PATH 检测 shell 可用性的需求
2. posix shell family 下是否需要支持 `process.kill(pid, 'SIGTERM')` 作为优雅退出策略（当前只实现了 `SIGKILL`）？
3. `ShellExecutionPlan` 是否需要暴露给审批展示层（如展示"即将以 PowerShell 执行以下命令"），以提升用户审批时的知情度？
4. 现有的 WSL/Git Bash 混合场景是否需要在 `shellKind` 枚举中单独表达，还是归入 `posix` 语义族？
