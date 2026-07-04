## 1. 新增类型定义

- [x] 1.1 新建 `src/adapters/tools/impl/system/terminal-types.ts`，定义 `ShellKind` 枚举、`ResolvedShellKind` 类型、`ShellExecutionPlan` 接口及 `PlatformExecutionOptions` 接口
- [x] 1.2 在 `terminal-types.ts` 中导出所有新类型，确保其他模块可直接 import

<!-- checkpoint: npx tsc --noEmit -->

## 2. 实现 ShellExecutionPlan 工厂

- [x] 2.1 新建 `src/adapters/tools/impl/system/terminal-plan.ts`，实现 `createShellExecutionPlan(command, shellKind?, config?)` 工厂函数
- [x] 2.2 实现 `resolveShellKind(input, platform, config)` 内部函数，按优先级决议 shell family（显式传入 > 配置 > 平台默认）
- [x] 2.3 实现 `buildPlatformOptions(resolvedKind, platform)` 内部函数，为各 shell family 填充 `killCommand`、`npmRewrite`、`encodingBootstrap` 等平台特化选项
- [x] 2.4 实现 `parseCommandToExecutable(coreCommand, resolvedKind, platformOptions)` 内部函数，生成最终的 `executable` + `argv` 数组
- [x] 2.5 处理边界情况：`shellKind` 与平台不兼容时返回明确失败（如 Linux 上指定 `powershell` 但环境中不可用），不得静默降级为其他 shell

<!-- checkpoint: npx tsc --noEmit -->

## 3. 重构 Guard 层（安全解析 shellKind 化）

- [x] 3.1 修改 `validateCommand()` 签名，接受可选的 `shellKind?: ResolvedShellKind` 参数；当显式传入 shellKind 时不再由 Guard 自行猜壳，而是基于已决议的 shell 语义进行校验
- [x] 3.2 抽取 `DANGEROUS_WRITE_COMMAND_REGEX` 为按 shellKind 分发的查找表（`DANGEROUS_WRITE_PATTERNS: Record<ResolvedShellKind, RegExp>`），posix 侧新增 `rm|dd|mkfs|chmod|chown` 等 POSIX 危险模式
- [x] 3.3 抽取 `READONLY_COMMAND_WHITELIST` 为按 shellKind 分发的查找表，posix 使用 `ls|cat|grep|head|tail|wc` 等 POSIX 命令，powershell 保留现有 `dir|git status|vitest` 等
- [x] 3.4 修改 `checkCommandSafetyLevel()` 接受 `shellKind` 参数，使用对应 shell family 的正则表和白名单进行安全评级
- [x] 3.5 修改 `unboxNestedCommand()` 的职责边界：接受可选的 `shellKind` 或已决议 Plan，上层显式指定 shell 时不再由 Guard 自行做壳推断；旧路径仍保留现有逐层剥壳行为
- [x] 3.6 修改 `isDangerousGitCommand()` 和 `isHardlineDangerous()`：Git 阻断规则跨 shell 通用保持不变，但 `HARDLINE_PATTERNS` 按 shell family 分流（posix 侧重 `rm -rf /` 和 `dd`，powershell 侧重 `Remove-Item -Recurse` 等）

<!-- checkpoint: npm test -- --testPathPattern="terminal-guard" -->

## 4. 重构 Engine 层（消费 ShellExecutionPlan）

- [x] 4.1 修改 `runCommandEngine()` 签名，新增接受 `ShellExecutionPlan` 参数（保留原 `command: string` 参数作为向后兼容路径，内部将 string 包装为默认 Plan）
- [x] 4.2 将 npm/npx `.cmd` 重定向逻辑从条件分支迁入 Plan 工厂，Engine 层改为直接消费 `plan.argv` 中的重定向结果
- [x] 4.3 将 PowerShell 编码注入逻辑从条件分支迁入 Plan 工厂，Engine 层改为直接消费 `plan.platformOptions.encodingBootstrap`
- [x] 4.4 修改 `killProcessTree()` 函数，接受 `plan.platformOptions.killCommand` 作为杀进程策略，保留 `process.kill` 作为降级兜底
- [x] 4.5 移除 Engine 层中与 shell 选择相关的 `process.platform === 'win32'` 条件分支；与底层进程树终止相关的平台实现可继续保留在独立工具函数中

<!-- checkpoint: npm test -- --testPathPattern="terminal-engine" -->

## 5. 扩展 Config 层

- [x] 5.1 在 `terminal-config.ts` 的 `GlobalState` 接口中新增 `defaultShellFamily: ShellKind` 字段
- [x] 5.2 实现 `loadDefaultShellFamily()` 函数，从配置文件和环境变量 `AGENT_DEFAULT_SHELL` 中读取默认 shell family；未配置时由平台决议逻辑提供默认值
- [x] 5.3 实现 `saveDefaultShellFamily(kind)` 函数，将默认 shell family 持久化写入配置文件
- [x] 5.4 在 `loadWorkMode()` 中同步加载 `defaultShellFamily`，确保配置加载的原子性

<!-- checkpoint: npx tsc --noEmit -->

## 6. 更新工具入口与审批对齐

- [x] 6.1 修改 `ExecuteCommandTool.definition`，在 `parameters.properties` 中新增 `shellKind` 字段（`enum: ['auto', 'posix', 'powershell', 'cmd']`，`default: 'auto'`）
- [x] 6.2 修改 `ExecuteCommandTool.checkSafety()`，将已决议的 `shellKind` 传递给 Guard 层的安全校验函数
- [x] 6.3 修改 `ExecuteCommandTool.execute()`，在调用 `runCommandEngine()` 前通过 Plan 工厂生成 `ShellExecutionPlan`，并将 Plan 传递给 Engine
- [x] 6.4 修改 `ApprovalPolicy.isHardlineCommand()`，将对 `bash`/`powershell` 工具名的检查改为对 `execute_command` + 已决议 shell 语义的检查，消除名称层面不一致
- [x] 6.5 在 `checkSafety()` 的审批展示信息中追加 shell family 提示（如"即将以 PowerShell 语义执行"），提升用户审批知情度

<!-- checkpoint: npx tsc --noEmit -->
<!-- checkpoint: npm test -->

## 7. 提示词同步与文档

- [x] 7.1 在 [prompts.ts](/D:/projects/MyAgent/src/core/usecases/brain/prompts.ts) 中补充 `execute_command` 的 `shellKind` 参数语义说明：推荐使用 `auto`，仅在明确需要特定 shell 语义时指定
- [x] 7.2 在提示词中说明 `shellKind` 枚举各值的含义：`auto` 自动选择、`posix` 用于 bash/sh 风格命令、`powershell` 用于 PowerShell 风格命令、`cmd` 用于 Windows 命令提示符

<!-- checkpoint: npx tsc --noEmit -->
