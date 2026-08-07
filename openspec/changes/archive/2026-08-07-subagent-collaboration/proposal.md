## 改造原因

子代理体系目前只有"启动 → 等待 → 收最终报告"的单向链路，缺少模型侧的协作控制面：

- **无法干预运行中任务**：主代理启动后台子代理后不能给它补充指令，也不能主动停止不需要的任务（当前只有用户 `/tasks stop`）。
- **无法续跑已结束子代理**：子代理报告"信息不足"后，主代理只能重新启动一个全新子代理，历史工作全部丢失。
- **无法按需读取输出**：子代理运行中过程对主代理不可见（task_update 只到 CLI），大输出只能经 deliveredOutput 全量进对话。

官方（Claude Code）已有一套经市场检验的对应机制（`queuePendingMessage` / `resumeAgentBackground` / `stopTask` / `diskOutput`），本 change 按 MyAgent 形态对齐实现：`SendMessage`（投递/恢复）、`TaskStop`（停任务）、Agent 工具返回 `outputFile`（主动读取通道）。安全标准以官方为基准（roadmap 决策记录 2026-08-07：安全对齐官方，不过度加严）。

## 变更内容

1. **新增 `SendMessage` 模型工具（子代理子集）**：按 `agent_id` 寻址——任务运行中 → 消息排队、子代理下一轮注入（官方 queued_command attachment 语义）；任务已终态 → 从 transcript 恢复并**后台续跑**（复用原 agentId）；任务不存在 → 稳定错误。
2. **新增 `TaskStop` 模型工具**：按 `task_id` 停止运行中任务（复用 TaskManager.cancel 幂等语义），返回结构化结果。
3. **Agent 工具返回扩展**：后台/前台结果携带 `outputFile`（该子代理 transcript 路径）与 `canReadOutputFile`（父工具面是否含 Read 类工具）。子代理运行中每轮循环结束写 transcript 快照，使 outputFile 在运行中可读。
4. **工具面装配**：`SendMessage`/`TaskStop` 注册进默认工具池，子代理工具面可见（对齐官方"不排除即包含"；MyAgent 子代理禁止嵌套，多两个工具无影响面增量）。
5. **恢复语义**：恢复任务强制后台（对齐官方 `isAsync: true`），完成经 task-notification 回报；恢复执行复用 runTask 既有链路（权限派生、工具作用域、输出扫描自动继承）。

无 BREAKING：全部为工具面新增与 schema 字段新增，向后兼容。

## 业务能力

### 新增业务能力
- `subagent-collaboration`: 模型侧协作工具面——`SendMessage` 消息投递与 transcript 恢复、`TaskStop` 停止运行中任务、`outputFile` 主动读取通道（Agent 工具返回扩展 + 运行中可见性）

### 修改业务能力
- `subagent-task-management`: 任务控制面反转——"任务管理不增加模型工具面"改为模型可经 `TaskStop` 停止任务；终态任务支持按原 agentId 重开（恢复的索引语义）
- `subagent-execution`: Agent 工具 schema 增加 `outputFile`/`canReadOutputFile` 返回字段（"Agent schema 只暴露阶段内字段"场景更新）；transcript 契约从"原子保存完整终态"扩展为"运行中每轮快照 + 终态快照"（"子代理 transcript 与主会话隔离"场景更新）

## 影响范围

- `src/core/usecases/subagent/`：SubagentRuntime（运行中快照、恢复入口、Agent 结果透传 outputFile）、SubagentCoordinator（SendMessage/TaskStop 路由、任务寻址）、TaskManager（终态重开、enqueueMessage）、SubagentTranscriptStore（运行中快照写入、读取 API）
- `src/core/usecases/engine/`：AgentLoop（每轮 pending 消息注入点）
- `src/adapters/tools/`：AgentTool（返回扩展）、新增 SendMessage/TaskStop 工具注册、工具面装配（默认池 + 子代理可见性）
- 任务状态与 transcript 持久化：TaskStateStore 终态索引、transcript 文件协议（快照频率变化，向后兼容）
- 测试：TaskManager/SubagentRuntime/工具面/transcript 相关单测与契约测试
