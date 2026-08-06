# subagent-task-management Specification

## Purpose

定义统一任务系统的生命周期契约：所有子代理执行（前台与后台）注册为任务（`taskId === agentId`）、有界 FIFO 状态机（`pending/running/waiting_approval/completed/failed/killed/interrupted`）、重启后诚实收敛、用户 `/tasks` 控制面、后台审批可观察与可取消、只交付扫描结果并携带用量、会话生命周期拥有任务，以及不新增模型任务工具面的边界。任务索引与主会话 snapshot 隔离，不重复保存 prompt、原始输出或凭据。

## Requirements

### Requirement: 所有子代理执行统一注册为任务

系统 SHALL 将每次子代理执行（前台或后台）注册为任务，任务 ID 与子代理 ID 相同。前台任务阻塞主循环，后台任务不阻塞；前台任务 MUST 支持在运行期间转为后台。

#### Scenario: 前台子代理注册为前台任务

- **WHEN** 主 Agent 同步调用 `Agent` 且未指定 `run_in_background`
- **THEN** 系统注册一个前台任务并阻塞等待其终态
- **AND** 该任务在 `/tasks` 中可见且状态为 `running`

#### Scenario: 前台任务超时自动后台化

- **WHEN** 前台任务运行时长超过 `subagentAutoBackgroundMs`（配置为正整数时）
- **THEN** 系统将该任务转为后台并立即向主循环返回 `async_launched` 结果
- **AND** 子代理执行在任务自己的取消控制器下继续，不随父调用取消

#### Scenario: 后台任务立即返回

- **WHEN** 主 Agent 使用 `run_in_background: true` 或 fork 路径创建子代理
- **THEN** 系统立即返回 `async_launched`、`agentId` 与 `description`
- **AND** 任务在 `/tasks` 中可见

#### Scenario: 任务 ID 与子代理 ID 一致

- **WHEN** 任一子代理执行被注册
- **THEN** 任务索引、transcript、通知中的 ID 为同一个 `agentId`
- **AND** 用户和模型可以用同一 ID 引用该任务

### Requirement: 后台任务使用有界 FIFO 生命周期

系统 SHALL 使用显式状态机 `pending -> running <-> waiting_approval -> completed|failed|killed` 管理后台任务，并支持进程重启后收敛为 `interrupted`。任务达到任一终态后 MUST NOT 回退到非终态。

#### Scenario: 并发槽位可用时立即运行

- **WHEN** 新任务提交时 running 与 waiting_approval 数量低于并发上限
- **THEN** 任务进入 `running` 并创建独立子代理执行

#### Scenario: 并发槽位已满时排队

- **WHEN** 新任务提交时并发槽位已满但在途总量未满
- **THEN** 任务以 `pending` 状态进入 FIFO 队列
- **AND** 前序任务进入终态后最早入队任务优先获得槽位

#### Scenario: 在途总量已满时拒绝

- **WHEN** pending、running 与 waiting_approval 的总数达到配置上限
- **THEN** 系统拒绝新任务并返回稳定的容量错误码
- **AND** 不创建孤立任务索引、transcript 或运行资源

#### Scenario: 完成与取消发生竞争

- **WHEN** 模型自然完成与取消信号近乎同时到达
- **THEN** 只有首个成功提交的终态生效
- **AND** 任务索引、transcript 和通知均使用同一最终状态

#### Scenario: 重启发现未完成任务

- **WHEN** 新进程加载到 `pending`、`running` 或 `waiting_approval` 索引记录
- **THEN** 系统将该记录原子转换为 `interrupted`
- **AND** 已存在的 running transcript 同步写入 `interrupted` 终态
- **AND** 不声称模型或工具工作已经恢复

### Requirement: 任务状态持久且保留有界

系统 SHALL 在 `state/subagents` 的父 session 隔离目录保存轻量任务索引。索引 MUST 原子更新，且 MUST NOT 重复保存 prompt、原始 assistant 输出、凭据或完整异常对象。

#### Scenario: 保存任务状态

- **WHEN** 任务创建、开始、等待审批或进入终态
- **THEN** 系统原子更新 agentId、类型、上下文策略、状态、时间、低敏错误摘要和 transcript 定位信息

#### Scenario: 清理历史终态任务

- **WHEN** 当前 session 的终态索引超过 100 条
- **THEN** 系统按结束时间清理最旧终态索引
- **AND** pending、running 与 waiting_approval 记录不得被清理

### Requirement: 用户可以查看和取消后台任务

系统 SHALL 提供 `/tasks`、`/tasks show <agentId>` 和 `/tasks stop <agentId|all>`，并只操作当前绑定 session 的任务。

#### Scenario: 列出当前会话任务

- **WHEN** 用户执行 `/tasks`
- **THEN** 系统按创建时间倒序显示 agentId、description、类型、状态和时间
- **AND** 不显示原始 prompt、原始 transcript 或凭据

#### Scenario: 查看完成结果

- **WHEN** 用户执行 `/tasks show <agentId>` 且任务已有 transcript
- **THEN** 系统显示扫描后的 `deliveredOutput` 或低敏错误摘要
- **AND** 不显示未经扫描的原始 assistant 文本

#### Scenario: 取消单个或全部任务

- **WHEN** 用户执行 `/tasks stop <agentId>` 或 `/tasks stop all`
- **THEN** 系统取消匹配的 pending、running 或 waiting_approval 任务
- **AND** 物理中止在途模型、工具和审批等待

#### Scenario: 取消终态或未知任务

- **WHEN** 用户取消当前 session 的终态任务
- **THEN** 系统返回幂等的无需取消结果
- **WHEN** ID 不属于当前 session 或不存在
- **THEN** 系统统一返回 not found，不泄露其他 session 是否存在该 ID

### Requirement: 后台审批可观察且可取消

系统 SHALL 在后台任务进入人工审批等待前将状态切换为 `waiting_approval`，并把任务取消信号传入父审批端口。

#### Scenario: 审批后恢复执行

- **WHEN** 父审批端口批准或拒绝后台工具调用
- **THEN** 尚未取消的任务从 `waiting_approval` 恢复为 `running`
- **AND** 工具网关按实际审批结果继续或拒绝该次调用

#### Scenario: 等待审批时取消

- **WHEN** `/tasks stop` 或会话关闭发生在 `waiting_approval`
- **THEN** 审批 Promise 被取消且任务进入 `killed`
- **AND** 被取消工具副作用不得开始

### Requirement: 后台终态只交付扫描结果并携带用量

系统 SHALL 在后台任务进入终态后发送一次任务状态事件，并通过会话通知边界向主 Agent 交付一次完成通知。成功通知 MUST 使用 `SubagentOutputScanner` 的交付副本，失败通知 MUST 使用低敏错误摘要；通知 MUST 携带 usage 用量段且只投递一次。

#### Scenario: 忙碌期间完成

- **WHEN** 后台任务在主 Agent 正在生成或存在未闭合 tool call 时完成
- **THEN** 完成通知进入现有消息缓冲而不立即插入历史
- **AND** 当前消息协议闭合后才允许刷新并触发既有自动唤醒

#### Scenario: 空闲期间完成

- **WHEN** 后台任务在主会话空闲时完成
- **THEN** 系统添加固定结构的安全通知并触发一次 `async_event`
- **AND** 自动唤醒继续受现有最多三次熔断限制

#### Scenario: 终态通知去重

- **WHEN** 终态写入、取消和恢复扫描重复观察同一任务
- **THEN** 任务索引中的 `notified` 标记保证主 Agent 最多收到一次终态通知

#### Scenario: 通知携带用量报告

- **WHEN** 后台任务成功或失败并生成终态通知
- **THEN** 通知包含 totalTokens、toolUses 与 durationMs 三项用量
- **AND** 用量来自子代理运行期间的模型 token 统计、工具调用计数和墙钟时长

#### Scenario: UI 状态事件不携带正文

- **WHEN** 任务状态发生变化
- **THEN** `task_update` 只携带 agentId、description、类型、状态和时间
- **AND** 不携带 prompt、原始输出、扫描输出或异常对象

### Requirement: 会话生命周期拥有后台任务

后台任务 SHALL 归属于提交它的父 session。会话关闭 MUST 停止接收任务、取消所有非终态任务，并在关闭父 ToolRegistry 和 MCP 连接前有界等待任务释放资源。

#### Scenario: 普通中止不误杀已接受后台任务

- **WHEN** 用户中止当前主 Agent 生成，但父 session 仍保持打开
- **THEN** 当前前台子代理随父调用取消
- **AND** 此前已成功入队的后台任务继续运行

#### Scenario: 会话关闭取消全部任务

- **WHEN** 父 session 开始关闭
- **THEN** 任务管理器拒绝新提交并取消全部 pending、running 与 waiting_approval 任务
- **AND** 清理完成或有界等待结束后才关闭共享父工具资源

#### Scenario: 会话恢复不混入其他任务

- **WHEN** CLI 恢复到另一 session ID
- **THEN** `/tasks` 只读取新绑定 session 的任务索引
- **AND** 不把先前 session 的通知、状态或取消操作路由到当前会话

### Requirement: 任务管理不增加模型工具面

后台任务查询和取消 SHALL 只通过 CLI driving port 暴露。本 change MUST NOT 注册新的模型任务管理工具。

#### Scenario: 模型枚举工具

- **WHEN** 主 Agent 或子代理枚举可用模型工具
- **THEN** 不存在 `Tasks`、`TaskOutput`、`TaskStop` 或等价新增工具
- **AND** 主 Agent 只通过现有 `Agent` 工具提交后台任务
