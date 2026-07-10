## 1. 诊断提醒与提示词约束

- [x] 1.1 梳理诊断、排障、磁盘清理建议类回合的识别边界，并在 `model-request-assembler` 中定义对应的动态提醒模板。
- [x] 1.2 将失败降级、证据分级、扫描停机和高风险清理提示按条件注入 `<system-reminder>`，避免污染普通编码任务。
- [x] 1.3 补充 `prompt` 与 `model-request-assembler` 测试，验证诊断类回合会注入约束、非诊断类回合保持最小提醒。

<!-- checkpoint: npx vitest run test/core/usecases/brain/prompt.test.ts test/core/usecases/engine/model-request-assembler.test.ts -->

## 2. 诊断规划状态与停机控制

- [x] 2.1 在 `agent-loop` 或相邻调度闭环中引入本轮诊断状态，记录系统查询失败、目录枚举预算、证据等级是否提升等信息。
- [x] 2.2 当系统查询已失败或被拦截时，阻断“升级为更复杂 shell 命令”的恢复路径，改为回退到内置只读工具、总结未知项或请求用户缩小范围。
- [x] 2.3 为连续 `listFiles` 扩散建立停机规则，确保在证据不再提升或预算耗尽时停止继续枚举。

<!-- checkpoint: npx vitest run test/core/usecases/engine/agent-loop.test.ts test/core/usecases/engine/tool-call-orchestrator.test.ts -->

## 3. 证据质量与清理建议安全

- [x] 3.1 将 `presence`、`enumeration`、`measured`、`error` 这四档证据边界落实到诊断回答约束中。
- [x] 3.2 为高风险清理对象建立禁止项或谨慎项规则，覆盖安装缓存、修复介质、共享组件缓存等容易被误判为“可直接删除”的目录。
- [x] 3.3 补充测试，验证无真实测量时不能宣称“深度扫描完成”或“主要占用项已确认”，且高风险目录不会被输出为绝对安全的清理建议。

<!-- checkpoint: npx vitest run test/core/usecases/brain/prompt.test.ts test/core/usecases/engine/model-request-assembler.test.ts test/core/usecases/engine/agent-loop.test.ts -->

## 4. 收尾验证

- [x] 4.1 运行类型检查，确认诊断状态与提醒注入改动未破坏现有编译边界。
- [x] 4.2 复核 OpenSpec delta、设计说明与实现保持一致，确保本次范围没有回流到终端 runtime 安全策略。

<!-- checkpoint: npx tsc --noEmit -->
