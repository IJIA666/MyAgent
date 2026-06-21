# Proposal - Sub-Agent Session Isolation

本变更（Change: `subagent-session-isolation`）旨在解决长期记忆异步提炼子智能体在执行期间由于自动物理写盘，导致无意义的自省临时会话 JSON 文件污染用户正常历史会话列表（`/history`）的问题。

## 1. 问题与现状
- **串扰污染**：当主智能体会话结束时，系统触发异步长期记忆提炼子智能体。该子智能体在内部 ReAct 循环中复用了 `ContextRepository.saveState()` 接口，导致它所产生的内存对话历史被物理写入到 `.myagent/sessions/` 目录下（产生例如 `1782049203662.json` 的文件）。
- **用户体验受损**：这些以随机时间戳命名的子智能体提炼历史文件会混杂在真实的用户历史会话中。当用户在交互终端输入 `/history` 查看会话时，会被展示大量无意义的历史记录，破坏了正常会话历史的隔离性，并造成磁盘文件垃圾累积。

## 2. 目标与收益
- **实现文件级隔离**：限制子智能体（自省临时推理）所持有的上下文状态数据库，使其仅在内存中流转，禁止对磁盘执行任何持久化写 I/O。
- **清除历史列表污染**：确保用户的 `/history` 列表中仅能查阅到真实的人机交互会话。

## 3. 影响范围
- 持久化接口：[ContextRepository.ts](file:///d:/Projects/MyAgent/src/core/usecases/ContextRepository.ts)
- 会话管理类：[session.ts](file:///d:/Projects/MyAgent/src/core/usecases/session.ts)
- 不影响现有的业务逻辑和主智能体的落盘行为。
