## 改造原因

当前终端命令的副作用分类、硬线危险判断、Plan 模式判定和最终权限决策仍分散在 `terminal-guard.ts`、工具 `checkSafety()`、工具 `checkPermissions()`、`ToolRegistry` 与旧 `ToolPolicyPort` 兼容路径中。虽然主运行时已经开始使用 `ToolPermissionService`，组合根、Registry、旧插件和工具类型仍保留第二套 `pass | suspend | deny` 契约，导致规格宣称的“唯一权限入口”尚未真正落地。

终端安全分析同时依赖跨 Shell 正则、白名单和多个重复布尔判断。当前复合命令试验实现还会在解析状态降级时把已经识别出的 `hardline` 覆盖为 `unknown`，说明在没有稳定分析契约前直接放开复合命令会削弱不可绕过的拒绝边界。但如果阶段 3 只完成内部重构而继续拒绝所有复合命令，也无法形成用户可感知的能力闭环。因此阶段 3 必须在同一个 change 内先统一“分析证据”和“最终权限决策”，再放开能够可靠拆分和逐段授权的基础复合命令。

## 变更内容

- 新增统一的 Shell 命令分析能力：按已决议的 `shellKind` 产生不可变分析结果，明确解析状态、原子命令、副作用、风险信号、资源和不可绕过的 deny/hardline 证据。
- 为 POSIX、PowerShell 和 CMD 提供独立分析器入口。阶段 3 首批支持 Bash 顶层 `;`、`&&`、`||` 和 PowerShell 顶层 `;`，将其拆成原子子命令逐段分析；CMD 复合语法及其他未覆盖结构继续标记为不受支持。
- 对复合命令执行整体聚合：任一子命令 deny 则整体 deny，任一子命令 ask 则整体 ask，只有全部子命令 allow 才整体 allow；持久授权建议按子命令生成，不得把完整复合字符串保存为宽泛规则。
- 规定风险聚合顺序：`hardline/deny` 永远优先于 `unknown`、写入、敏感读取和普通读取；解析失败或能力不足只能阻止 allow，不能覆盖已识别的拒绝证据。
- 将终端 `checkPermissions()` 收敛为分析结果到 `allow | ask | deny | passthrough` 的唯一工具级映射，并保证同一次权限评估只生成一次命令分析结果。
- 落实现有统一权限规格：由 `ToolCallGateway + ToolPermissionService + PermissionPromptAdapter` 组成唯一决策与 ask 交互链，Registry 只负责路由和 effect 组装。
- **BREAKING（内部契约）**：删除已弃用的 `ToolPolicyPort`、`checkSafety()`、`SafetyCheckResult`、`BuiltinToolPolicyAdapter`、`ToolPolicyRouter` 和未装配的 `HumanApprovalPlugin` 兼容路径；不改变模型可见工具名称和 JSON Schema。
- 阶段 3 放开上述可可靠分析的基础复合命令。管道、重定向、后台执行、换行、子 Shell、命令替换、脚本块、控制流、完整 Bash/PowerShell AST、OS 沙盒和自动代码质量门禁删除均不属于本 change。

## 业务能力

### 新增业务能力

- `shell-command-analysis`: 按 Shell family 生成可复用、可逐子命令聚合且 deny 优先的命令分析证据，为统一权限决策和基础复合命令执行提供单一输入。

### 修改业务能力

- `terminal-tool`: 用 Shell 感知的逐段分析替换基于单一跨 Shell 字符正则的原子命令契约，放开已支持连接符组成的基础复合命令，同时继续拒绝未覆盖的复杂 Shell 结构。

## 影响范围

- 终端分析与执行边界：`src/adapters/tools/impl/system/terminal-guard.ts`、`terminal.ts`、`terminal-types.ts` 及新增的 Shell 分析模块。
- 权限入口与审批适配：`src/adapters/tools/ToolCallGateway.ts`、`toolRegistry.ts`、`ToolExecutor.ts`、`src/core/domain/permissions/*`、`PermissionPromptAdapter.ts`。
- 旧路径清理：`src/ports/shared/tool-policy.ts`、内建/外部策略适配器、策略路由器、`HumanApprovalPlugin.ts` 以及组合根和 Session 构造参数。
- 测试：终端单元测试、权限服务与网关契约测试、Registry/MCP/tail call 集成测试、旧符号零残留检查。
- 阶段 3 不新增生产依赖；后续阶段选择 AST 实现时再单独评估依赖、平台支持和性能成本。
