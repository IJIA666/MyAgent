# 设计方案: 安全模式与会话隔离分层测试

## 1. 架构目标

以高内聚、低侵入的分层测试策略（Unit + Integration 融合），确保重构的 5 大新增核心安全防线（Plan 模式、黑名单拦截、机密文件分级保护、多会话物理隔离、级联审批熔断）有 100% 的边界测试覆盖。

## 2. 技术设计

### 2.1 组件级单元测试 (Unit Tests)

- **终端黑名单与只读拦截 (`test/action/terminal.test.ts`)**：
  - 构造模拟的 `SessionContext` 并将其 `workMode` 设为 `'Plan'`。
  - 调用 `ExecuteCommandTool.checkSafety`，验证传入非只读指令（如 `npm run dev`）返回 `deny`。验证传入只读白名单指令（如 `git log`）返回 `pass` 或 `suspend`。
  - 验证敏感的底线命令（如 `rm -rf /`，`format`，`mkfs`）在任何模式下均无条件返回 `deny`。

- **批量审批熔断数据结构 (`test/brain/ApprovalService.test.ts`)**：
  - 调用 `wait()` 并为挂起的 Promise 绑定不同的 `sessionId`（例如：会话 A 绑定 2 个待审批，会话 B 绑定 1 个待审批）。
  - 调用 `rejectBySessionId(sessionId, error)`，验证只有匹配该 `sessionId` 的会话 A 的所有待审批被 reject 释放，并且会话 B 的挂起任务仍安全保留在 Map 中正常工作。

- **敏感文件分级校验 (`test/action/tools.test.ts`)**：
  - 对 `.env` 及其变体，验证调用 `ReadFileTool.checkSafety` 即使在 YOLO 下也返回 `suspend`，目标路径为解析后的真实绝对路径。
  - 验证 `WriteFileTool.checkSafety` 写入 `.env` 返回 `suspend` 并在 message 中包含明文。
  - 验证 `EditFileTool.checkSafety` 修改 `.env` 返回 `suspend` 并在 message 中包含 old_string 与 new_string 的 Diff 差分。
  - 验证 `.env.example` 文件的自由访问在 YOLO 模式下返回 `pass`。

### 2.2 端到端集成测试 (`test/integration/safety-cascade-isolation.test.ts`)

- **测试基础设施的组装**：
  - 手动实例化 `SessionContext`、`ApprovalService`、`HumanApprovalPlugin` 和 `ToolRegistry`。
  - 在隔离环境中进行会话的模拟交互。
  
- **并发多会话隔离用例**：
  - 并发创建会话 A（YOLO 模式）和会话 B（Plan 模式）。
  - 在会话 A 中触发一个工具命令，由于是 YOLO 模式应该直接放行并执行。
  - 在会话 B 中触发写命令（副作用操作），由于是 Plan 模式应当被直接 `deny` 拦截，验证其隔离状态完全物理独立。

- **级联熔断与中断重塑用例**：
  - 在一个 Session 下并行触发三个需要人工审批的工具。
  - 模拟前端交互，对其中第一个审批调用 `resolve(id, { action: 'deny' })` 进行驳回。
  - 验证当前执行链路唤醒，且其余两个待审批被自动 `reject` 释放。验证其余被熔断的工具调用抛出了 `HaltedByReject` 格式的异常。

## 3. 测试环境资源清理与生命周期

- 所有读写 `.env` 及临时文件的单测，必须在各自用例的 `afterEach`/`afterAll` 中执行同步的删除和环境清退，防止残留在工作区中导致 git status 变脏。
