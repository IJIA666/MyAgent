# subagent-at-mention Specification

## Purpose

定义用户输入 `@agent-<type>` 提及已注册子代理类型时的引导契约：提及转成高优先级提醒消息（引导模型经 Agent 工具调用，**不绕过 Agent 工具**）。对齐官方 `agent_mention` attachment 语义（attachments.ts:1966-1993 解析、messages.ts:3946-3953 渲染），按 MyAgent 形态适配（无 attachment 管道，提醒以独立 user 消息注入）。

## Requirements

### Requirement: 用户输入 @-mention 转高优先级提醒

系统 MUST 在 CLI 交互用户输入（handleUserInput 路径）进入会话前检测 `@agent-<type>` 提及（正则 `(^|\s)@agent-([\w.:@-]+)\b`，对齐官方 extractAgentMentions 格式）。提及类型已注册（`SubagentDefinitionRegistry.resolve` 命中）时 MUST 注入一条提醒 user 消息（多条提及合并为单条，置于用户消息之前），措辞表明"用户表达了调用对应子代理的意图，请适当调用并传递所需上下文"，并显式给出 `subagent_type`；未注册类型 MUST 不注入且不改写原始文本；全部未命中时 MUST 保持零变化。提醒 MUST 仅作引导——子代理启动仍经 Agent 工具既有全链（权限、工具作用域、输出扫描、通知），MUST NOT 提供任何旁路。

#### Scenario: 已注册类型提及注入提醒

- **WHEN** 用户输入 `@agent-reviewer 帮我评审这段代码` 且 `reviewer` 已注册
- **THEN** 会话在用户消息前出现一条提醒 user 消息（提及 `reviewer` 与 `subagent_type: reviewer`）
- **AND** 用户原始消息完整保留，模型可经 Agent 工具调用 `reviewer`

#### Scenario: 纯提及输入

- **WHEN** 用户输入仅为 `@agent-explore` 且 `Explore` 已注册
- **THEN** 注入提醒（提及 `Explore`）
- **AND** 用户消息本身保留 `@agent-explore` 文本

#### Scenario: 未注册类型不注入

- **WHEN** 用户输入 `@agent-not-exist 继续` 且类型未注册
- **THEN** 不注入任何提醒
- **AND** 用户消息原样进入会话（`@agent-not-exist` 文本保留）

#### Scenario: 多条提及合并为单条提醒

- **WHEN** 用户输入同时提及 `@agent-a` 与 `@agent-b`（均已注册）
- **THEN** 仅注入一条聚合提醒（同时列出 `a` 与 `b`）
- **AND** 不产生连续多条 user 消息

#### Scenario: 无提及零变化

- **WHEN** 用户输入不含 `@agent-` 提及
- **THEN** 不注入任何提醒
- **AND** 会话行为与现状完全一致

#### Scenario: 提醒不绕过 Agent 工具

- **WHEN** 提醒注入后模型决定调用子代理
- **THEN** 子代理经 Agent 工具启动（走既有权限派生、工具作用域、输出扫描与通知链路）
- **AND** 不存在绕过 Agent 工具直接启动子代理的路径
