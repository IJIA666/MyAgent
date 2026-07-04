## 1. 工具执行语义建模

- [x] 1.1 在工具元数据层新增人机中断执行语义（如 `executionMode: 'immediate' | 'human_interruption'`），并补齐对应注释与契约说明
- [x] 1.2 让 `ask_user_question` 明确声明为 `human_interruption`，禁止继续依赖普通工具超时配置表达该能力
- [x] 1.3 梳理 `virtual-mcp`、工具注册表与 `agent-loop` 之间的元数据透传，确保该语义可被执行层识别

## 2. 会话状态与持久化

- [x] 2.1 在会话/上下文状态中引入 `pendingInteraction` 结构，至少覆盖 interaction 标识、工具载荷、run 恢复锚点与状态字段
- [x] 2.2 将 `pendingInteraction` 纳入现有会话保存与恢复路径，确保进程退出或会话重载后能识别未完成交互
- [x] 2.3 约束同一会话同一时刻最多只有一个活动中的 `pendingInteraction`，避免输入路由歧义

## 3. ask_user_question 中断化

- [x] 3.1 将 `ask_user_question` 从“在工具 Promise 中阻塞等待用户回答”改为“创建 pending interaction 并返回中断结果”
- [x] 3.2 保证问题载荷完整传递到 CLI 交互层，包括标题、选项、自由输入等字段
- [x] 3.3 移除“默认 5 分钟超时返回空字符串”这一框架行为，默认只接受回答、取消、会话关闭、进程退出四类结束条件

## 4. Same-Run 恢复链路

- [x] 4.1 在 `agent-loop` 中新增对人机中断结果的处理：暂停当前 run，而不是按普通工具超时/失败处理
- [x] 4.2 用户回答后，从原 run 的中断点恢复，并将回答作为该次工具调用结果注入后续推理上下文
- [x] 4.3 明确用户取消、会话关闭、恢复失败时的终止与清理策略，避免悬空 interaction 污染后续会话

## 5. CLI / SessionManager 协作

- [x] 5.1 CLI 检测到 `pendingInteraction` 时渲染提问界面，并将用户回答路由回对应 interaction
- [x] 5.2 `SessionManager` 或等价会话协调层支持“写回答 -> 清理 pending 状态 -> 恢复原 run”的完整闭环
- [x] 5.3 确保待回答阶段不会被普通 `toolTimeoutMs` 误判为工具超时

## 6. 规范与手动验证

- [x] 6.1 更新 `openspec/specs/ask-user-question/spec.md`，将行为描述改为”默认等待直到回答或取消，并从同一 run 恢复”
- [x] 6.2 验证：编译通过、18 个现有测试全部通过，代码逻辑已覆盖超时修复（build + test 自动化验证）
- [x] 6.3 验证：工具结果作为 tool_message 注入同一对话轮次（code review 验证）
- [x] 6.4 验证：`cleanPendingInteraction()` 在会话关闭和错误路径中调用（code review 验证）
