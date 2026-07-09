## 改造原因

当前 `Plan` 模式下终端命令审批存在三层规则不一致的结构性缺陷：

1. **前置评级层**（`checkCommandSafetyLevel`）：以只读白名单前缀做粗粒度判定，`dir /-C /w C:\Windows\Temp` 被识别为"可进入下一步"的只读命令。
2. **审批提示层**（`checkSafety` in `terminal.ts`）：Plan 模式下，非白名单命令被硬拦截并返回自愈引导，但白名单命中命令会继续走到审批 UI。然而 `extractSafePrefix` 无法为 `dir /-C` 这类带参数命令生成持久化前缀，导致审批文案与真实执行能力脱节。
3. **执行期校验层**（`validateCommand`）：对 `|`、`>`、`<`、`%` 等复合符号做严格结构校验，即使命令已通过前置审批，执行期仍可能被拒绝。

这三套规则**非同构**——前置评级判断可以进入审批，审批可以弹出，但执行期最终仍然拒绝，造成"审批通过却无法执行"的假阳性体验。会话证据已证实该分层不一致在真实运行中反复发生。

## 变更内容

1. **重新定义 Plan 模式的终端边界**：将 Plan 从"无终端模式"重新定义为"无副作用模式"。在该模式下，允许极小集合、可静态证明安全的系统只读查询进入统一审批管线，但继续禁止复合连接、重定向、环境变量展开和脚本化语法。
2. **强制前置审批与执行期校验同构**：前置安全评级与执行期结构校验在允许集合上必须严格一致。一旦命令会被执行期结构校验拒绝，前置层必须同步拒绝，杜绝"审批成功但执行失败"的假阳性。
3. **保留命令审批作为宿主机观测护栏**：本次变更不把 Plan 模式下的安全只读查询改成静默放行，而是保留用户审批，避免借修复假审批问题顺带扩大宿主机只读观测能力。
4. **更新 Plan 模式的系统提示词规则**：明确 Plan 模式下终端工具的"无权写"（可审批的只读查询）而非"无权存在"的语义，使 AI 模型能够合理利用系统只读查询能力而不被误导。

**不涉及**：
- 放宽复合 shell 语法（`|`、`>`、`<`、`%` 等）——这会把安全模型从静态可判定退化为语义猜测
- 把 Plan 模式下的安全只读命令改成默认静默放行
- 扩展 `extractSafePrefix` 或改变持久化命令前缀授权粒度——这属于独立的审批能力设计问题，应由后续 change 单独处理
- 新增专用只读工具（如 `wmic`、`systeminfo` 包装器）——由后续 change 单独处理
- 改变 YOLO / Auto / Safe 模式下的终端行为
- 修改 `terminal-engine.ts` 的进程执行逻辑

## 业务能力

### 新增业务能力
- 无：本次变更不引入任何全新的独立业务能力。

### 修改业务能力
- `base-security`: Plan 模式下终端拦截行为从"硬拦截所有非白名单命令"改为"允许可静态证明安全的只读查询进入审批，禁止复合/重定向/展开语法"；错误消息中的自愈引导词同步更新以反映新的边界语义。
- `terminal-tool`: 前置安全判定与执行期结构校验的允许集合需做同构对齐，确保只有真正可执行的只读查询才可能进入审批流程。

## 影响范围

- **`src/adapters/tools/impl/system/terminal-guard.ts`** — `checkCommandSafetyLevel` 与 `validateCommand` 规则同构对齐；新增 Plan 模式专用安全检查函数
- **`src/adapters/tools/impl/system/terminal.ts`** — `ExecuteCommandTool.checkSafety` 中 Plan 模式拦截逻辑重构：从"block all non-whitelist"改为"deny invalid readonly candidate + suspend valid readonly query"
- **`src/core/usecases/brain/prompts.ts`** — `RULE_TOOL_PRIORITY` 规则的 Plan 模式终端语义更新
