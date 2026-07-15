## 改造原因

阶段 3 已统一 Shell 命令分析、权限证据和 `deny > ask > allow` 决策链，但只开放 Bash 顶层 `;`、`&&`、`||` 与 PowerShell 顶层 `;`。管道、重定向、后台执行和嵌套结构仍被整体标记为 `unsupported`，与 Claude Code“允许 Shell 语法进入逐子命令分析，无法证明安全时退回询问”的行为还有明显差距。

阶段 4 复用 `2026-07-14-unify-command-analysis-and-policy/exploration.md` 的调研结论，在不削弱 hardline 边界的前提下分批扩大复合命令支持。

## 变更内容

- 在复合命令扩展前删除完成响应后自动运行 ESLint/TypeScript、失败后自动驱动模型修复的代码质量门禁；保留 AI 或用户主动执行检查命令的能力。
- 以 Claude Code 的 Bash 复合命令能力作为最低兼容目标，并按 PowerShell 自身语义提供对应能力，不再通过结构字符一律拒绝命令。
- 按“纯读取管道 → 条件链 → 重定向 → 后台执行 → 嵌套结构”分批接入分析和执行；每批拥有独立能力开关、测试矩阵和回退边界。
- 对管道段、连接命令、重定向目标和嵌套命令分别生成证据，再按 `deny > ask > allow` 聚合；只有全部结构均可分析且允许时才可自动执行。
- 合法但尚未覆盖、解析能力不足或超过分析上限的结构只能 `ask` 或 `deny`，不得自动 `allow`；已识别 hardline 或语法无效输入继续直接 `deny`。
- Bash 与 PowerShell 使用各自的解析规则；CMD 在建立可靠分析能力前不承诺复合语法自动放行。
- 保持 `execute_command` 的模型可见名称和参数 Schema 不变。

## 业务能力

### 新增业务能力

无。

### 修改业务能力

- `shell-command-analysis`: 扩展管道、连接符、重定向、后台及嵌套结构的 Shell 专用分析，并将未覆盖但非 hardline 的合法结构从一律拒绝调整为保守询问。
- `terminal-tool`: 分批开放 Claude Code 已支持的复合命令执行能力，复用统一权限证据并保留不可绕过的拒绝边界。
- `postrun-quality-gate`: 删除自动触发、自动修复、取消和步骤计时契约。
- `agent-event-lifecycle`: 删除 `quality_check_status` 非终结事件契约。
- `logging-observability-and-naming`: 删除自动质量门禁专用日志链和 UI 状态要求。
- `ports-isolation`: 删除不再存在的 `QualityCheckPort` 依赖反转场景。
- `trace-logging`: 删除自动质量门禁 trace span，保留其他诊断阶段追踪。
- `long-term-memory-refinement`: 删除为规避 PostRunHook 而伪装写工具安全类别的要求。

## 影响范围

- Shell 分析器：`src/adapters/tools/impl/system/command-analysis/`。
- 自动质量门禁：`AgentLoop`、Session/组合根注入、质量检查端口与适配器、AgentEvent、CLI 渲染和专用日志。
- 终端权限与执行：`terminal.ts`、`terminal-guard.ts`、统一权限证据及 Gateway 执行链。
- 分析器内部能力覆盖：各复合语法批次可在测试与紧急诊断中独立关闭；正常运行默认启用全部已验收能力，不向用户暴露环境配置。
- 测试：Bash/PowerShell 分析、权限聚合、执行语义、开关回退、hardline 与解析失败场景。
- 可能需要引入或封装 Shell 解析能力；具体依赖选择和平台约束在 `design.md` 中确定。
