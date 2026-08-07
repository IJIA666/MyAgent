# 3a 探索：子代理协作与控制面（消息投递/恢复、TaskStop、outputFile）

> 状态: active
> 创建: 2026-08-07
> 依据: 官方源码核实（LocalAgentTask.tsx / resumeAgent.ts / stopTask.ts / diskOutput.ts / AgentTool.tsx）+ MyAgent 现状核实（SubagentRuntime / SubagentCoordinator / TaskManager / SubagentTranscriptStore / AgentLoop）
> 上游: openspec/explorations/subagent-evolution-roadmap.md 阶段 3a

---

## 1. 目标与范围

对齐官方三项能力，全部为**模型侧工具面能力**（模型发起，用户命令 `tasks`/`subtask` 已有）：

1. **子代理消息投递与恢复**：主代理按 agentId 向运行中子代理排队消息（下一轮收到），或从 transcript 恢复已结束子代理继续对话。
2. **TaskStop 模型工具**：主代理停止运行中任务（含后台）。
3. **outputFile 机制**：Agent 工具返回输出文件路径 + `canReadOutputFile`，主代理可主动读取子代理运行中/完整输出。

## 2. 官方机制核实

### 2.1 消息投递（queuePendingMessage → attachments）

- `queuePendingMessage(taskId, msg, setAppState)`（LocalAgentTask.tsx:162）：消息 push 进 task.pendingMessages。
- 投递点：`getAgentPendingMessageAttachments`（attachments.ts:1085-1098）——每轮请求组装时 `drainPendingMessages` 取出，转成 `{ type: 'queued_command', prompt }` 的 Attachment **注入子代理下一轮 API 请求**。
- 只对**运行中**任务有效；已停止任务走恢复路径。

### 2.2 恢复（resumeAgentBackground，resumeAgent.ts）

- 读 transcript（`getAgentTranscript`）+ metadata（`readAgentMetadata`）。
- 过滤三类的孤儿消息：`filterWhitespaceOnlyAssistantMessages`、`filterOrphanedThinkingOnlyMessages`、`filterUnresolvedToolUses`（未闭合 tool_use 的 assistant 消息剔除）。
- `reconstructForSubagentResume`（toolResultStorage）：重建 tool_result 与 contentReplacement 映射（避免恢复后 tool_result 缺失）。
- promptMessages = `[...resumedMessages, createUserMessage(prompt)]` → `runAgent(isAsync: true, agentId 复用)` → **后台续跑**。
- 返回 `{ agentId, description, outputFile }`；**复用原 agentId**（registerAsyncAgent 同名注册，元数据续写）。
- 定义解析：优先原 agentType（activeAgents 中查找），找不到回退 general-purpose；fork 类型特殊处理（重建父 system prompt）。

### 2.3 TaskStop（stopTask.ts）

- `stopTask(taskId, ctx)`：查任务 → 必须 `running`（否则 StopTaskError not_running）→ `taskImpl.kill(taskId)`。
- shell 任务抑制 "exit 137" 通知；agent 任务不抑制（AbortError catch 带 `extractPartialResult(agentMessages)` 部分结果）。
- TaskStopTool schema：`task_id`（必填）+ 废弃的 `shell_id`。

### 2.4 outputFile（diskOutput.ts + AgentTool.tsx）

- 统一任务输出落盘：`<project-temp>/<sessionId>/tasks/<taskId>.output`；`MAX_TASK_OUTPUT_BYTES = 5GB` 磁盘上限。
- **本地子代理**：`initTaskOutputAsSymlink(agentId, transcriptPath)`（LocalAgentTask.tsx:483/547）——output 文件是 **transcript 文件的符号链接**，运行中随 transcript 追加（官方 transcript 为 JSONL 实时追加）。
- Agent 工具返回：`outputFile: getTaskOutputPath(agentId)` + `canReadOutputFile`（父工具面是否有 Read/Bash，AgentTool.tsx:753）。
- 读取侧：`getTaskOutputDelta`（按字节偏移增量读，上限 8MB）/ `getTaskOutput`（tail 读）。
- 清理：`evictTaskOutput`（flush + 卸内存 map，不删文件）/ `cleanupTaskOutput`（删文件）；会话 close、/clear 时调用。

## 3. MyAgent 现状核实

| 能力 | 现状 | 缺口 |
|---|---|---|
| 任务索引 | TaskManager（agentId = taskId，entries map + TaskStateStore），`get(agentId)` 可查状态 | 投递需按 agentId 定位运行中任务（entries 私有，需暴露 API） |
| 停任务 | `TaskManager.cancel(agentId)` 幂等（TaskManager.ts:205），`SubagentCoordinator.cancelTask` 已暴露（/tasks stop 底层） | **无模型工具**（TaskStop）——工具面注册即可 |
| transcript | SubagentTranscriptStore 完整落盘：`<subagentsDir>/<父session哈希>/<agentId>/transcript.json`，含**原始 messages**、deliveredOutput、agentType/model/contextPolicy；原子替换式（终态快照，运行中仅写一次 running 基线） | **无读取 API 暴露给模型**；运行中不增量写入（官方 JSONL 实时追加） |
| 恢复素材 | transcript 有完整 messages + agentType + model，可重建子代理初始历史 | **无恢复入口**；终态任务不能复用 agentId 重提（TaskManager entries.has 拒绝重复） |
| 循环注入点 | AgentLoop.chat 每轮 `modelRequestAssembler.assemble`（agent-loop.ts:341） | 无 pending 消息注入机制 |
| 运行中输出可见性 | 无（task_update 仅到 CLI） | 需增量落盘或 transcript 快照 |
| 大输出 | 全部经 deliveredOutput 进对话 | 无按需读取通道 |

## 4. 设计要点（MyAgent 形态）

### 4.1 消息投递

- 新模型工具（暂名 `SendMessage`，仅子代理子集，不做 swarm）：`agent_id` + `message`。
- 路由：任务 running → 队列投递；任务终态 → 走恢复；任务不存在 → 稳定错误。
- 注入点：AgentLoop 每轮 assemble 前将 pending 消息作为 user 消息加入 childContext（官方 queued_command attachment 语义等价）。**只对后台子代理有实际消费者**：前台子代理期间主代理 LLM 处于等待，无法调用工具（官方同样如此）。
- TaskManager 暴露 `enqueueMessage(agentId, msg)` + AgentLoop 每轮 drain。

### 4.2 恢复

- 读 transcript（SubagentTranscriptStore.read）→ 过滤未闭合 tool_use 等孤儿消息（对齐官方三类过滤；MyAgent 无 thinking 消息，需核实）→ 重建 tool_result 引用 → `[...messages, user(prompt)]` 作为新任务初始历史 → 复用原 agentId 或新 agentId 后台续跑。
- **agentId 复用的技术约束**：TaskManager entries.has 拒绝重复 + TaskStateStore 索引终态。需决策：复用 agentId（对齐官方，需 TaskManager 支持终态任务重开）还是新 agentId（简单，但 agentId 变化破坏"恢复同一任务"的寻址语义）。
- 恢复执行路径 = runTask 复用（权限派生、工具作用域、输出扫描天然继承——安全不降级）。

### 4.3 TaskStop

- 新模型工具 `TaskStop`：`task_id` → `SubagentCoordinator.cancelTask(taskId)` → 结构化结果（成功/非运行中/未找到）。
- 对齐官方语义：非运行中返回错误（MyAgent cancel 更宽松——非终态皆可取消，工具层映射）。

### 4.4 outputFile

- Agent 工具（后台/接受态与前台结果）返回 `outputFile`（transcript 路径）+ `canReadOutputFile`（父工具面含 Read 类工具）。
- **运行中可见性**：MyAgent transcript 是原子替换快照（运行中只有 running 基线）——需要新增运行中增量写入（周期快照或逐轮追加 messages），否则 outputFile 只能读终态。决策点：增量写入频率与体积控制。
- **读取权限**：transcript 路径在 subagentsDir（应用路径）——需确认在父模型 Read 工具的授权范围内，否则需专门授权（官方靠 temp 目录自动放行）。
- **与输出扫描的关系**：输出扫描（MyAgent 自研，官方无）保护**自动交付通道**（deliveredOutput 进对话前标记注入）。outputFile 是父模型**主动读文件**，与读子代理写的任何工作文件同权，官方从不扫描工作文件——transcript 文件也只是文件。故 outputFile **暴露原始 transcript（官方形态）**，输出扫描边界不变（自动通道继续扫描）。此决策在 roadmap 机制基线第 3 条明示（"自动交付通道唯一边界"）。

### 4.5 工具面接入

- 新工具（SendMessage/TaskStop）注册进默认工具池（子代理工具面是否含它们：官方在主线程才有；子代理内是否允许投递/停止兄弟任务——官方允许（task_id 任意）但 MyAgent 需决策是否限制）。
- 输出扫描作用于新工具的返回结果（工具返回为结构化文本，扫描器照常处理）。

## 5. 待决策点

| # | 决策 | 结论 |
|---|---|---|
| D1 | 恢复时 agentId 复用 or 新 ID | **复用**（官方方案：resumeAgentBackground 复用 agentId 续写元数据），需 TaskManager 支持终态重开 |
| D2 | outputFile 暴露原始 transcript or 扫描副本 | **原始 transcript（官方方案）**：主动读文件与读任意工作文件同权；输出扫描边界 = 自动交付通道 |
| D3 | 运行中增量写入方式 | **每轮循环结束写快照**（低成本近似；官方为 JSONL 逐消息追加，改造点为存储协议全链路：写/读/回退保护/updateStatus/测试） |
| D4 | SendMessage/TaskStop 是否在子代理工具面可见 | **可见（官方方案）**：官方不排除（TaskStop 无门控全量；SendMessage 受 swarm 开关控制）；子代理禁止嵌套，多两个工具无影响面增量 |
| D5 | 恢复任务的背景模式 | **强制后台**（官方方案：isAsync: true），完成经 task-notification 回报 |
| D6 | 工具命名 | **`SendMessage`、`TaskStop`**（官方命名，roadmap 命名基线照搬） |
