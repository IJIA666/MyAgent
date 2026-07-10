## 1. 探索制品归档

- [x] 1.1 生成并保留 `openspec/explorations/terminal-notification-message-order.md`。
- [x] 1.2 生成并保留 `openspec/explorations/terminal-plan-readonly-policy.md`。
- [x] 1.3 生成并保留 `openspec/explorations/terminal-advisory-warning-parser.md`。
- [x] 1.4 生成并保留 `openspec/explorations/tool-denial-audit-coverage.md`。

## 2. 终端同步/后台通知边界

- [x] 2.1 修改 `terminal-engine.ts`，仅在显式后台或自动后台化后的异步托管任务完成时触发 completed notification。
- [x] 2.2 保持 watch match 与 stalled 通知行为不变。
- [x] 2.3 补充同步快速命令不注入 notification、后台托管命令完成会通知的测试。
<!-- checkpoint: npx vitest run test/adapters/tools/safety-and-concurrency.test.ts test/core/usecases/engine/loopback.test.ts -->

## 3. Plan 只读系统查询与告警解析

- [x] 3.1 将 `cmd` 与默认 PowerShell 路径中的 `wmic logicaldisk` 纳入 Plan 模式只读白名单，并保持其它 `wmic` 前缀拒绝。
- [x] 3.2 让 `detectAdvisoryWarnings()` 按 shell family 跳过命令开关参数，避免把 `/A:H`、`/W` 当作路径。
- [x] 3.3 补充 `isPlanSafeCommand()` 与 advisory warning 单元测试。
<!-- checkpoint: npx vitest run test/adapters/tools/terminal.test.ts -->

## 4. 前置拒绝审计

- [x] 4.1 在 `BeforeTool` 前置 abort 分支写入最小 audit 生命周期记录。
- [x] 4.2 保证 abort audit 记录只包含摘要字段，不写原始工具参数和结果。
- [x] 4.3 补充契约测试验证被拒绝工具调用进入 audit。
<!-- checkpoint: npx vitest run test/contract/diagnostic-data-governance.test.ts test/contract/tool-call-orchestration.test.ts -->

## 5. 工具失败闭环补齐

- [x] 5.1 在 `agent-loop.ts` 中为“已有最终错误但缺少 `toolMessage`”的调用补写 `tool` 错误消息。
- [x] 5.2 区分执行前参数解析失败与执行期失败，确保参数 JSON 非法时给出明确回填文案。
- [x] 5.3 补充 `agent-loop` 测试，验证参数解析失败不会静默丢失 `tool` 消息。
<!-- checkpoint: npx vitest run test/core/usecases/engine/agent-loop.test.ts -->

## 6. 收尾验证

- [x] 6.1 运行类型检查。
- [x] 6.2 复核 OpenSpec delta 与实现保持一致。
<!-- checkpoint: npx tsc --noEmit -->
