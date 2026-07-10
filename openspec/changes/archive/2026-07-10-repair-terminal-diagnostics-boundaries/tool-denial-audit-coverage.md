# 探索主题: 工具前置拒绝的审计覆盖

## 1. 问题定义
本次会话中，`call_00_Awbi0A9JDNXxJbInL1n81831` 被 Plan 模式前置拒绝，并写入 session 快照为 tool 回执，但 audit 文件完全没有该调用。审计缺口导致最关键的拒绝原因无法从 `.myagent/traces/audit_*.jsonl` 中追溯。

## 2. 关键发现与调研结果
- **代码库现状**：`HumanApprovalPlugin` 的权重是 10，`TracerLogPlugin` 的权重是 100；`runHookPipeline()` 在 `sandboxContext.control.action !== 'continue'` 时直接短路后续中间件。因此 `HumanApprovalPlugin` 将 `context.control.action` 置为 `abort` 后，审计插件不会执行 `BeforeTool` 记录。
- **核实与洞察**：audit 文件只包含 `call_01_FhLpq3xze7jr53V1EFEO2294` 的 BeforeTool/AfterTool，未包含被拒绝的 `call_00`。这不是 trace metadata-only 的预期省略，而是审计生命周期事件缺失。

## 3. 方案对比与推荐方向
| 评估维度 | 方案 A: 提高 TracerLogPlugin 权重提前记录 | 方案 B: 在管线短路后补记录最终生命周期状态 | 结论 |
| :--- | :--- | :--- | :--- |
| 能否记录最终拒绝原因 | 提前记录时还看不到 abort | 能记录最终 control/action | B 更准确 |
| 对插件顺序影响 | 改变审计插件观察点 | 保持现有插件执行顺序 | B 更稳 |
| 实现范围 | 只改注册顺序或权重 | 需要管线或审计插件补充 after-dispatch 观察点 | B 更符合审计语义 |

**推荐路径**：保持 `TracerLogPlugin` 晚执行以观察最终状态，同时让 `runHookPipeline()` 在短路返回前保证审计插件能记录最终 `control` 状态。可选实现是为 `TracerLogPlugin` 提供高优先级外层包裹或在 `ToolCallOrchestrator` 的 abort 分支显式写入安全摘要；推荐优先选择不改变所有插件语义的局部补审计。

## 4. 约束、风险与未知项
- audit 仍不得写入原始工具参数和结果，只能写 argument keys、digest、资源摘要、policy result 和状态。
- 需要避免同一个正常工具调用产生重复 BeforeTool 审计记录。

## 5. 否决方案
- **只依赖 session snapshot 排查拒绝**：session snapshot 包含原始消息和工具回执，不是最小审计制品，也不应承担 audit 职责。
- **让 TracerLogPlugin 权重小于 HumanApprovalPlugin**：会记录到未决策的 `continue` 状态，仍然看不到拒绝结果。
