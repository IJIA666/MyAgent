## MODIFIED Requirements

### Requirement: 会话上下文管理

系统必须（MUST）在内存中完整维护当前会话的消息队列（包括 System Prompt、User Messages、Assistant Responses，以及所有 Tools 调用输入与反馈），并在发起大模型请求时完整传递。

#### Scenario: 工具参数解析失败仍保留 tool 响应闭环

- **WHEN** 模型发起了一条 `tool_calls`，但该调用在真正执行前就因 arguments JSON 非法而失败，导致调度链路仅产出最终错误而未生成 `toolMessage`
- **THEN** 系统必须补写一条与原 `tool_call_id` 绑定的 `role: "tool"` 错误消息进入会话历史，明确该失败属于参数解析阶段，避免 assistant tool call 与 tool response 之间出现静默断裂
