## 改造原因

`ask_user_question` 当前把“等待用户选择”错误地当成了“普通工具执行中的等待”。结果是：

- `InteractionHandler` 虽然声明了 5 分钟等待，但外层 `agent-loop` 的统一 `toolTimeoutMs`（默认 30 秒）会先触发；
- 用户只要在提问界面停留超过 30 秒，就会被错误打成“工具执行超时熔断阻断”；
- 更关键的是，这暴露了一个架构问题：**等待人类协作不应该落入普通工具超时语义**。

结合本仓库真实调用链、`D:\projects\Agents` 下 Claude Code / OpenCode 的实现，以及 OpenAI 官方关于 human review / resumable state 的文档，可以确认：

- 这不是简单的超时值配置错误；
- 也不是把 30 秒改成 5 分钟就能真正修复的问题；
- 正确方向应当是：**把 `ask_user_question` 提升为 human interruption，默认无自动超时，并从同一 run 的状态恢复继续执行**。

## 变更内容

1. **引入人机中断执行语义**：在工具元数据层区分普通即时工具与 `human_interruption` 工具，避免继续用单一 `toolTimeoutMs` 覆盖所有工具。

2. **将 `ask_user_question` 改造为中断式交互**：当模型调用该工具时，系统不再在普通工具 Promise 中阻塞等待，而是记录一个待回答的 interaction，暂停当前 run。

3. **引入可恢复的 pending interaction 状态**：将问题载荷、工具调用标识、创建时间等信息写入会话状态，使用户回答后可以从同一 state 恢复同一 run，而不是伪造一个新的用户轮次。

4. **默认取消自动超时**：`ask_user_question` 的用户选择默认无自动超时。合法结束条件仅包括：用户明确回答、用户明确取消、会话关闭、进程退出；未来若业务需要 deadline，应由调用方显式声明，而不是框架默认注入。

5. **同步更新 ask-user-question 规范**：将规范从“默认 5 分钟超时返回空字符串”调整为“默认等待直到回答或取消，并从同一 run 恢复”。

## 业务能力

### 新增业务能力

- `human-interruption-lifecycle`：为需要人类参与的工具提供 interruption、pending state 与 resume 机制。

### 修改业务能力

- `ask-user-question`：从“带超时的阻塞式工具调用”升级为“默认无超时的人机中断式交互”。

## 影响范围

- `src/adapters/tools/virtual-mcp.ts`
- `src/ports/driven/tools/ToolRegistryPort.ts`
- `src/core/usecases/engine/agent-loop.ts`
- `src/core/usecases/engine/session.ts`
- `src/core/domain/context.ts` 或相关会话状态结构
- `src/adapters/input/interface/facade.ts`
- `src/adapters/input/interface/interaction-handler.ts`
- `src/adapters/tools/impl/interaction/ask-user-question.ts`
- `openspec/specs/ask-user-question/spec.md`

## 边界说明

- 本 change 聚焦 `ask_user_question` 的等待边界修复与中断恢复语义，不顺带处理 `multiSelect` 未实现等独立完成度问题。
- 审批链路未来可以复用同类 interruption 底座，但本 change 不要求把审批体系一起重构进来。
