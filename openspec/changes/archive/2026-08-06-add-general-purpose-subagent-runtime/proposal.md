## 改造原因

MyAgent 已能为 Skill Review 创建隔离的 `SessionContext` 与 `AgentLoop`，但该能力被固化在 Skill 专用服务中，主 Agent 没有可调用的通用子代理工具，其他功能也无法安全复用独立模型循环、工具收窄、权限派生和上下文装载能力。继续按功能复制隔离 Agent 代码会造成权限、模型实例、生命周期和会话存储语义分叉。

本次先建立可复用的同步子代理执行内核，并交付一个前台 `general-purpose` 子代理。它形成独立可用闭环，同时为后续后台子代理与 exact-fork 提供稳定基础，而不提前引入后台任务生命周期。

## 变更内容

- 新增模型可调用的 `Agent` 工具；第一期仅接受 `general-purpose` 类型，并同步等待子代理完成后返回最终报告。
- 新增通用子代理执行内核，为每次调用创建独立上下文、独立 LLM 客户端、独立 caller、独立预算与受作用域约束的工具注册表视图。
- 定义子代理工具可用性策略和父权限派生规则；前台子代理不得扩大父会话权限，也不得使用不适用于子代理的交互或会话控制工具。
- 新增独立子代理 transcript 存储；原始子代理消息与主会话快照分离，主会话压缩、回滚和保存不得混入子代理内部轨迹。
- 新增确定性的子代理输出扫描边界；原始 transcript 保持不变，交付主 Agent 的结果必须转义角色/保留标签伪装并附带命中标记。
- 将 Skill Review/Skill Curator 的隔离运行部分迁移到通用执行内核，但保留其现有触发、排队、三工具限制、后台 caller、禁止人工审批、消息回放、结果通知和关闭语义。
- 本次不提供后台 `Agent` 调用、exact-fork、`/subtask`、`/tasks`、自定义 Agent Markdown、Explore/Plan、嵌套、恢复、worktree 或后台审批回传；这些由后续 change 承担。

## 业务能力

### 新增业务能力

- `subagent-execution`: 主 Agent 可通过统一 `Agent` 工具同步运行隔离的 `general-purpose` 子代理，并获得经过安全扫描的最终报告；子代理运行具有独立模型实例、权限边界、工具作用域和 transcript。

### 修改业务能力

无。Skill Review 与 Skill Curator 仅迁移内部执行基础设施，其既有需求契约保持不变。

## 影响范围

- 核心：新增子代理定义、上下文构造、执行协调、输出扫描和 transcript 存储模块，并从 `background-skill-review.ts` 抽取通用隔离执行能力。
- LLM：新增按冻结 `LlmConfig` 创建独立 `LlmPort` 的工厂端口与 OpenAI 兼容实现，避免父子代理共享可变驱动实例。
- 工具：新增原生 `Agent` 工具、子代理工具可见性元数据和 schema-preserving 的作用域注册表包装；继续通过统一 `ToolCallGateway` 执行。
- 权限：新增前台子代理权限派生与 caller 深度信息，不改变主会话现有 PermissionMode、规则仓储或审批协议。
- 持久化：在应用数据目录的会话状态区域新增独立子代理 transcript 布局，不修改主会话 snapshot 格式。
- 测试：增加通用运行器、工具作用域、独立 LLM、输出扫描、transcript、`Agent` 工具真实链路及 Skill Review/Curator 回归测试。
