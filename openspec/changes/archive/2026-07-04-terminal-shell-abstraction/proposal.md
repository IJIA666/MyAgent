## 改造原因

当前 `execute_command` 工具的实现在 `terminal-guard.ts`、`terminal-engine.ts`、`terminal-config.ts` 和 `ApprovalPolicy.ts` 中散落着大量 Windows/PowerShell 特化逻辑。安全网关已经能识别 `sh|bash|cmd|powershell|pwsh` 这些 shell family，安全策略层也接纳了 `bash`/`powershell` 名称分支——但工具暴露层、解析层和执行层之间缺少一个受控的中间抽象来收口这些分散的平台语义。继续维持这种"隐式混合"状态，Linux 适配的成本只会越来越高，且各层之间的不一致性会持续扩大。

本次改造的目标不是拆分出多个顶层工具，而是保留单一 `execute_command` 对外接口，在内部新增平台语义抽象层，为后续 Linux 支持铺平道路。

## 变更内容

- 新增可选的 `shellKind` 入参（`auto | posix | powershell | cmd`），推荐默认值 `auto`，模型无需手动选择即可获得明确的平台默认行为
- 新增 `ShellExecutionPlan` 中间数据结构，将"平台默认值选择 → 命令归一化 → 安全解析模式 → 实际 `exe + argv` 生成"统一收口
- 重构 `terminal-guard.ts` 的安全解析逻辑，使其按 `shellKind` 语义执行命令剥离与白名单匹配，而非继续隐式混合推断
- 重构 `terminal-engine.ts` 的执行路径生成，将当前 Windows 特化的 `shell: false`、`.cmd` 重定向、PowerShell 编码修正等逻辑迁入对应 shell family 的执行计划中
- 扩展 `terminal-config.ts` 的配置模型，增加默认 shell family 与平台感知的默认值选择
- 消除 `ApprovalPolicy.ts` 中"策略层已接纳多壳但工具层未注册"的不一致性

## 业务能力

### 新增业务能力
- `terminal-shell-abstraction`: 终端 Shell 抽象层——定义 `shellKind` 枚举、`ShellExecutionPlan` 接口及跨平台执行计划的生成与消费契约，使上层工具与下层执行引擎通过受控抽象解耦

### 修改业务能力
- `terminal-tool`: 在 `execute_command` 工具的外部契约中新增可选的 `shellKind` 参数，同时确保现有安全策略（原子化操作拦截、工作区沙箱锁死、Git 写操作绝对阻断等）在跨 shell family 场景下保持一致

## 影响范围

- **核心执行链路**：`ExecuteCommandTool` → `terminal-guard.ts` → `terminal-engine.ts` 整条命令执行主链将新增 `ShellExecutionPlan` 中间层
- **安全与审批**：`ApprovalPolicy.ts` 中的多壳名称分支将与实际工具注册状态对齐
- **配置层**：`terminal-config.ts` 将新增 shell family 相关的配置项
- **模型暴露面**：`execute_command` 工具的 JSON Schema 参数定义将新增可选 `shellKind` 字段，模型提示词可能需同步更新以说明该参数的语义
- **接口层无强制 BREAKING 变更**：`shellKind` 为可选参数，现有调用方无需修改；但 `auto` 的默认分辨率将被显式制度化，尤其在 Windows 平台上可能把当前隐式执行语义收敛为明确的 `powershell` 语义，因此该 change 不再承诺“未传参时运行结果与现状完全一致”
