## 1. 任务管理扩展（终态重开 + 投递队列）

- [x] 1.1 `TaskStateStore` 新增 reopen 专用路径（已核实 create 拒绝重复 agentId，TaskStateStore.ts:72）：读旧记录校验终态 → 替换 records 旧条目 → 复用 create 建新记录（覆盖语义，不做新旧并存）
- [x] 1.2 `TaskManager.reopen(agentId, input)`：校验旧记录终态（非终态拒绝）→ 移除旧内存 entry → 以同一 agentId 重新 submit（新 entry/controller）
- [x] 1.3 `SubagentTranscriptStore` 新增显式 `beginResume` 写入：终态校验后允许新一轮 `running` 记录覆盖（已核实终态不可回退，SubagentTranscriptStore.ts:97；仅恢复路径显式调用，普通写仍受回退保护）
- [x] 1.4 `TaskManager.enqueueMessage(agentId, msg)` 与 `drainMessages(agentId)`：内存投递队列，非终态（pending/running/waiting_approval）可入队，drain 取空且多条合并为一次注入；终态/未知任务入队返回稳定错误
- [x] 1.5 终态结算兜底：任务进入终态时队列非空 → 自动切换到恢复路径（队列消息合并作为恢复 prompt）

<!-- checkpoint: npm run build -->

## 2. transcript 运行中快照与读取通道

- [x] 2.1 `AgentLoop` 新增确定性回调 `onRoundCommitted`：每轮模型响应提交、assistant 消息入 context 后必调（agent-loop.ts:512-513，与 usage 无关；已核实 onModelUsage 依赖可选 usage 不可用，LlmPort.ts:37）
- [x] 2.2 `SubagentRuntime` 在 `onRoundCommitted` 内以 childContext 历史写 `running` 状态 transcript 快照（原子替换，复用既有写队列），终态快照仍为权威
- [x] 2.3 提交点初始化 transcript：任务提交（出队前）写初始基线记录，排队期 outputFile 即存在；读取侧容忍 ENOENT 返回空（对齐官方 getTaskOutputDelta 语义）
- [x] 2.4 `Agent` 工具结果（后台接受态与前台终态）返回 `outputFile`（transcript 路径）与 `canReadOutputFile`（父工具面是否含 Read 类工具）
- [x] 2.5 `canReadOutputFile` 计算落点：协调器提交点经 `parentSession.getLatestModelRequestSnapshot().tools` 判断（对齐官方 FILE_READ_TOOL_NAME 判断，不做白名单——已核实 FileRead 基线 allow，tool-permission-service.ts:337）

<!-- checkpoint: npm run build -->

## 3. 投递注入点（AgentLoop）

- [x] 3.1 `AgentLoop` 新增可选 `pendingMessageProvider`：每轮请求组装（assemble）前调用，返回的待投递消息以 user 消息注入子代理上下文（非打断式，对齐官方 queued_command 语义）
- [x] 3.2 `SubagentRuntime` 构造 loop 时接入 `TaskManager.drainMessages(agentId)` 闭包，投递消息进入子代理下一轮请求

<!-- checkpoint: npm test -- test/core/usecases/subagent -->

## 4. SendMessage 工具与恢复路径

- [x] 4.1 `SendMessage` 工具实现：必填 `agent_id`/`message` 校验；按任务状态路由——非终态 → 入队投递；终态 → 恢复路径；未知 → 稳定错误
- [x] 4.2 恢复路径：`SubagentTranscriptStore.read` 读终态 transcript → 校验 contextPolicy 非 exact-fork 且 persistTranscript → 剔除末尾未闭合 tool_use 的 assistant 消息 → `SubagentContextBuilder.buildResume`（剥离旧 system → RuleManager 重建基础 system + 当前定义正文 → 回放去 system 历史 → 追加新 user）→ `TaskManager.reopen`（同 agentId、强制后台）+ `parentSessions` 重绑（已核实终态删除，SubagentCoordinator.ts:258）→ runTask
- [x] 4.3 恢复定义解析：transcript 的 agentType → `SubagentDefinitionRegistry.resolve`，未注册回退 general-purpose；fork 类型与无 transcript 任务返回稳定错误
- [x] 4.4 `SubagentExecutionResult` 类型扩展：新增 `outputFile`/`canReadOutputFile` 字段，运行器与协调器两处结果映射同步
- [x] 4.5 `SendMessage` 注册进工具目录（schema、权限分类、描述），结果可序列化

<!-- checkpoint: npm test -- test/core/usecases/subagent -->

## 5. TaskStop 工具

- [x] 5.1 `TaskStop` 工具实现：必填 `task_id` → 仅 `running` 状态调用 `SubagentCoordinator.cancelTask(taskId)`；`pending`/`waiting_approval`/终态返回 `not_running`、未知返回 `not_found`（对齐官方 stopTask 只停 running）
- [x] 5.2 `TaskStop` 注册进工具目录（schema、权限分类、描述、正式权限适配器）

<!-- checkpoint: npm test -- test/core/usecases/subagent -->

## 6. 工具面装配与契约对齐

- [x] 6.1 `SendMessage`/`TaskStop` 进入主代理默认工具池（模型可发现），并加入子代理禁用名单（对齐官方 `ALL_AGENT_DISALLOWED_TOOLS` 含 TaskStop，constants/tools.ts:43；SendMessage 仅主代理可见）
- [x] 6.2 契约测试更新：`subagent-task-management` 工具面需求反转（主代理枚举含 TaskStop 不含 Tasks/TaskOutput、子代理不含 TaskStop/SendMessage）、`subagent-execution` Agent 返回字段与运行中快照场景
- [x] 6.3 全量门禁：lint + build + 单测（1241）+ 契约测试（133）+ 测试类型检查

<!-- checkpoint: npm run lint -->

<!-- checkpoint: npm test -->

<!-- checkpoint: npm run test:contract -->
