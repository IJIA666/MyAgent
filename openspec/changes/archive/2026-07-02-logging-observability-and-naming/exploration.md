# 探索主题: 日志系统可观测性与命名优化

## 1. 问题定义

本次探索的目标已经从“日志系统全面重构”收缩为“提升调试可观测性，同时避免误改存储语义”。当前日志相关痛点主要集中在三类：

1. **诊断信息不足**：`session.ts`、`context.ts` 中多个关键状态切换缺少稳定日志，排查事件生命周期、自动唤醒链路和工作模式切换时仍然依赖反推时间线。

2. **文件命名与检索不友好**：`trace`、`audit`、`session` 文件仍以纯时间戳或易碰撞的会话标识命名，可读性和唯一性都不足，不利于按会话快速定位。

3. **trace 体积与语义边界不清**：当前 trace 已经能形成黑匣子记录，但内容仍存在重复上下文、记录联合类型不闭合和补丁时序理解偏差的问题，需要在不破坏可回放性的前提下做结构化优化。

> 结论先行：本次不建议继续沿着“session JSONL 化、run.log 二次清理、生命周期框架扩展”推进；这些方向要么会破坏现有恢复语义，要么会引入不必要的框架改造。

## 2. 关键发现与核实

### 2.1 日志系统现状

| 组件 | 文件 | 当前写入方式 | 现状判断 |
|:---|:---|:---|:---|
| LogTape | `src/utils/logger.ts` | `.myagent/run.log`，`getRotatingFileSink` | 已有轮转，`maxFiles: 5` 已限制保留数量，不存在“无限增长”的前提 |
| AgentTracer | `src/core/domain/tracer.ts` | `.myagent/traces/trace_${sessionId}.jsonl` | 仍是按会话文件追加写入，但命名唯一性和内容结构都可改进 |
| ContextRepository | `src/core/usecases/brain/ContextRepository.ts` | `.myagent/sessions/{sessionId}.json` 覆盖写 | 当前语义是“最新可恢复状态快照”，不是操作日志 |

### 2.2 需要修正的事实

- `run.log` 的轮转配置已经具备基础保留能力。除非需求明确变成“按天保留 30 天”，否则不应再额外叠加清理逻辑。

- `ContextRepository.saveState()` 和 `loadState()` 是一对快照读写语义，直接改成 JSONL 追加会破坏恢复逻辑，还会引入尾行损坏、兼容迁移和并发一致性问题。

- trace 里只保留一次 system prompt 的想法过于激进。更合理的是记录 `systemPromptHash`，首次出现或内容变化时写完整 prompt，后续仅引用 hash。

- `sessionId` 目前仍来自 `Date.now().toString()`，不具备真正的唯一性保证。可读性可以保留，但必须升级为 UTC 毫秒前缀加完整 UUID。
- 进一步收敛后，`sessionId` 应该作为单一主键一次生成、全链路复用，trace、audit、session 都要挂在同一个身份上。

- `LifecycleManager` 目前只承担 shutdown cleanup，不应为了日志清理额外扩展出 startup 框架。

### 2.3 复核数据

根据本次复核，当前 `.myagent` 规模仍然较小，体量不足以支撑“必须马上做复杂保留策略”的结论。现阶段更应该优先解决的是：

- 日志可读性
- 唯一命名
- 关键状态诊断
- trace 结构化表达
- 快照串行保存与回退
- 旧格式兼容读取

而不是先引入新的文件生命周期框架。

## 3. 方案对比与推荐

| 评估维度 | 方案 A | 方案 B | 结论 |
| :--- | :--- | :--- | :--- |
| `run.log` 保留策略 | 追加独立清理逻辑 | 保持现有轮转，不额外改造 | 选 B |
| session 持久化 | 改成 JSONL 追加 | 保持 JSON 快照，必要时做临时文件原子替换 | 选 B |
| trace 内容 | 每轮重复写完整上下文 | 用 `meta` + `prompt_definition` + `iteration` + 读取器回放 | 选 B |
| 会话命名 | 时间戳后缀 + 4 位伪随机值 | UTC 毫秒前缀 + 完整 UUID | 选 B |
| 清理入口 | 扩展 `LifecycleManager` startup | 独立清理函数，在日志初始化前直接调用 | 选 B |

**推荐路径**：优先做“诊断补全 + 命名改造 + trace 结构化”，暂不触碰 session 快照语义和生命周期框架。

## 4. 约束、风险与未知项

- **快照语义不可破坏**：`ContextRepository` 的恢复语义是本次探索的硬边界，不能为了统一格式而把快照改成日志。

- **命名改造需要迁移策略**：新旧文件命名需要同时识别，避免恢复、排查和后续清理时把历史文件误判为垃圾文件。

- **活跃会话必须保护**：如果未来引入保留策略，必须明确当前活跃 session 不能删除，清理失败也不能阻断启动。

- **trace 完整性需要优先于压缩率**：任何压缩方案都必须保留回放所需信息，不能把“减小体积”放在黑匣子完整性之前。

- **量化结论要可复现**：文件体量、数量和增长预测必须基于明确样本和统计口径，不能只给经验数字。

- **敏感信息治理仍需补齐**：system prompt、工具结果、路径和可能的密钥信息，后续需要明确脱敏边界。

## 5. 否决方案

- **session JSONL 统一化**：否决。会直接破坏现有恢复逻辑，且会把快照与审计日志混为一谈。

- **run.log 二次清理**：否决。当前轮转已经约束了文件数量，额外清理没有足够收益。

- **startupCleaners 框架扩展**：否决。为一次日志整改引入生命周期框架改造，收益不匹配复杂度。

- **只写一次 system prompt**：否决。黑匣子可回放性优先，必须保留变化感知机制。

## 6. 后续建议

如果继续推进，建议把后续工作拆成三步：

1. 先补 `session.ts`、`context.ts` 的关键状态日志，保证事件生命周期可追踪。
2. 再统一 `trace`、`audit`、`session` 的命名规则，并让三类文件共享同一个 UTC 毫秒 + UUID 的 sessionId。
3. 然后补齐 `TraceReader`，确保回放、旧格式兼容和损坏尾行处理有明确实现。

## 7. 测试验证结论（2026-07-02）

### 7.1 日志级别噪音

`generation_requested`、`generation_cycle_started`、`generation_cycle_finished`、`snapshot_saved` 四条日志使用了 `logger.info()`，导致正常操作信息淹没了终端。控制台 sink 默认过滤级别为 `info`，这些高频事件应该降为 `debug`——正常操作只落文件，控制台仅显示 `warn`/`error` 级别。

已修正为 `logger.debug()`。

### 7.2 WorkMode 切换失败的诊断提升

`work_mode_change_blocked` 日志（`context.ts` 中 `setWorkMode()` 的 `isProcessing` 检查处）成功捕获了模式切换失败的瞬间，输出 `[WRN]` 级别的结构化日志。这验证了诊断日志补全的方向是正确的——不需要反推时间线就能看到切换被拒的原因。

### 7.3 isProcessing 变迁日志验证（第二轮测试）

`plugin-runner.ts` 中已加入 `isProcessing_changed` 的 `logger.debug()` 日志。第二轮测试验证结论：

- **`isProcessing` 没有泄漏**。第一轮 `generation_cycle_finished`（12:46:09.405）后，所有 hook pipeline 的 `isProcessing` 都正确恢复为 `false`。11 秒静默窗口内无任何 hook 活动。
- **`work_mode_change_blocked` 的根因不在 session 层**。WorkMode 切换被拒时 `isProcessing` 为 `true`，但该锁是由第二轮 `generation_requested`（12:46:20.221，`reason=user_input`）触发的。`handleUserInput` 在 WorkMode 切换之前或同时被调用——根因在 `facade.ts` 的 `handleLineSubmit` 中，`/` 菜单的命令分发链异常路径上意外重投了用户消息。
- **日志系统改造目标达成**。每条 hook pipeline 的精确耗时（0-24ms）现在可观测；`generation_*`/`snapshot_saved` 降为 debug 级别，控制台不再被淹没。

建议在 `plugin-runner.ts` 中为 `isProcessing` 转变加 `logger.debug()`，携带 `eventName` 和 `sessionId`。
