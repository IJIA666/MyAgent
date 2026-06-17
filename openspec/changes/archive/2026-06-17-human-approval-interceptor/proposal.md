## 改造原因

当前系统赋予了大模型直接执行系统级终端命令的高权限，仅有一层基于基础正则和路径约束的 `terminal-guard.ts`，无法拦截语义层面的高危动作（如 `rm -rf`）。为了在提升安全性的同时，实现底层架构调度与外层交互表现（UI/CLI）的完美解耦，我们需要引入基于原生 `Promise` 挂起与事件机制的 “方案 B++” 人机审批流拦截器。

## 变更内容

- 引入一个全新的 `ApprovalService` 来维护大循环外部的阻塞等待挂起凭证（Deferred Promises），自带超时兜底。
- 扩展内核的 `AgentEvent` 事件，支持 `suspend` 事件类型，用于向外层 UI 抛出交互请求信号。
- 引入新的 `HumanApprovalPlugin` 插件，将其挂载于 `BeforeTool` 生命周期。它负责基于正则嗅探敏感操作、抛出事件，并调用 `ApprovalService` 执行安全的协程原地阻塞。
- 彻底清理现有终端执行工具中硬编码的 `readline` 或提示交互逻辑，使其回归纯函数无状态。

## 业务能力

### 新增业务能力
- `human-approval`: 智能体危险动作的人机协同审批（Human-in-the-Loop）机制

### 修改业务能力
- 

## 影响范围

- **内核模块**：`src/brain/context.ts`（注入 `ApprovalService`）、`src/brain/agent-loop.ts`（新增 `suspend` 事件类型，大循环状态机零入侵）、`src/brain/session.ts`（注册并装配新插件与服务）。
- **工具模块**：`src/action/native-tools/terminal-guard.ts` 或相关终端执行函数去耦合。
- **外部表现层（宿主环境）**：CLI 入口或 Web 端控制器必须配合监听 `suspend` 事件，弹出审批并负责调用 `ApprovalService.resolve` 唤醒引擎。
