## 改造原因

第一期已经具备安全、隔离的同步 `general-purpose` 子代理，但主 Agent 必须一直等待子代理结束，用户也无法查看、取消或管理长时间运行的子任务。同时，现有 `fresh` 上下文无法满足"沿当前会话继续分支处理"的需求。

对照 Claude Code 源码梳理其子代理体系后，确认其核心是**统一任务系统**：所有子代理（前台与后台）都注册为任务，前台/后台只是任务的阻塞属性，前台任务可随时转为后台；fork 是上下文初始化维度，模型（受实验开关控制）与用户命令都能创建。本次变更据此对齐官方机制与命名：

- 建立统一任务系统：前台与后台子代理都注册为任务，前台任务带后台化信号，可中途转为后台。
- 为现有 `Agent` 工具补齐 `description`（必填）与后台提交；模型在配置开关开启时可请求 fork 子代理，`/subtask` 作为用户入口并存。
- 后台完成结果通过现有安全通知边界交付主 Agent，携带扫描副本与 usage 用量报告。

## 变更内容

- 扩展 `Agent` 工具 schema：新增必填 `description`（3-5 词任务摘要，用于任务列表与通知展示）、可选 `run_in_background`；fork 开关开启时省略 `subagent_type` 即隐式 fork 且强制所有 Agent 调用后台运行并隐藏 `run_in_background` 字段，关闭时保持默认 `general-purpose` 与显式前后台语义。
- 建立统一任务系统：所有子代理执行注册为任务（`taskId === agentId`），后台任务进入 FIFO 队列并有并发/在途上限；前台任务支持按 `subagentAutoBackgroundMs` 配置超时自动转后台（本 change 不提供手动快捷键，Ctrl+B 留待后续）。
- 实现 `exact-fork`：冻结父会话最近一次模型请求的最终组装快照（消息含记忆投影与插件改写、过滤后工具集合、冻结模型配置），对未闭合工具调用按 MyAgent 消息协议合成占位 `tool` 消息闭合历史，父系统提示字节继承；fork 子代理枚举与父工具 schema 字节一致，调用阶段按子代理身份拒绝递归与交互工具。
- 增加有界任务状态机（`pending/running/waiting_approval/completed/failed/killed/interrupted`）、状态持久化、原子终态转换与重启中断收敛。
- 增加 `/subtask <prompt>`（用户创建后台 exact-fork）与 `/tasks`、`/tasks show`、`/tasks stop` 用户控制面。
- 为 `freshBackground` 与 `fork` 完成工具策略审计：后台白名单对齐官方 16 项思路（不含浏览器工具），fork 透传父工具池但调用时按 caller 深度拒绝；后台任务继续经过独立权限状态和统一工具授权，人工审批通过父会话审批端口回传。
- 将后台完成结果通过现有安全通知缓冲与自动唤醒边界交付主 Agent（`task-notification` 结构，含扫描副本、低敏错误与 usage），并提供不携带原始输出的任务状态事件。
- 为后台子代理增加运行时并发、在途总量和自动后台化时长配置；第一期仍禁止子代理继续创建子代理。
- 保持 Skill Review/Skill 整理任务的触发、工具白名单、不落盘与通知语义不变。

## 业务能力

### 新增业务能力

- `subagent-task-management`: 定义统一任务系统的注册、排队、状态、持久化、通知、查询、取消和会话关闭行为。

### 修改业务能力

- `subagent-execution`: 在既有同步 `fresh` 子代理基础上增加 `description` 契约、后台提交、`exact-fork`（模型与用户双入口）、后台工具策略、fork 精确工具池和审批路由契约。
- `agent-event-lifecycle`: 增加非终结性的任务状态事件，并规定后台完成通知只能在消息协议安全边界触发后续生成。
- `config-runtime-limits`: 增加后台子代理并发数、在途任务总量和自动后台化时长的正整数配置契约；本期嵌套深度固定为 1。

## 影响范围

- 子代理驾驶端口、定义注册表、上下文构造器、公共运行器、作用域工具注册表和会话绑定控制器。
- 新增统一任务管理器、任务状态仓储、审批路由和完成通知适配器。
- `Agent` 工具 schema、原生/MCP 子代理策略元数据、会话取消/关闭顺序与 `AgentEvent` 联合类型。
- CLI 会话端口、Slash Command 注册、帮助/交互菜单和任务状态渲染。
- `RuntimeLimitsConfig`、配置加载与共享测试夹具。
- 不增加新的模型工具（`TaskStop`、`SendMessage` 等留待后续）、不引入自定义 Markdown Agent、Agent Team、worktree、跨进程任务恢复、子代理模型/provider 覆盖或多层嵌套。
