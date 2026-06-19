## 改造原因

在前一阶段的变更 `safety-mode-session-switch` 中，我们重构并加固了智能体的核心安全机制，包括只读 `Plan` 模式、底线黑名单拦截、机密凭证保护、多会话隔离及级联熔断。
虽然重构后的实现顺利通过了全部 77/77 个现有测试用例，但新增的五大安全特性在现有测试套件中缺乏任何用例覆盖（测试覆盖率为 0%）。为了防范代码退化并构筑健壮的安全质量防线，我们极有必要补充对应的测试集。

## 变更内容

1. **组件级 Unit Test (就近补充)**：
   - 在 `test/action/terminal.test.ts` 中补充只读 `Plan` 模式对写命令的拦截单元测试；底线黑名单（如 `rm -rf /`）在 YOLO/Safe 模式下的无条件 `deny` 拦截单元测试。
   - 在 `test/brain/ApprovalService.test.ts` 中补充 `rejectBySessionId` 数据结构批量清理以及不干扰其他会话的单元测试。
   - 在 `test/action/tools.test.ts` 中补充 `ReadFileTool`、`WriteFileTool`、`EditFileTool` 对敏感文件（`.env`）读写及覆盖的 `suspend` 降级卡关和明文/Diff展示单元测试，以及放行 `.env.example` 的单元测试。
2. **端到端 Integration Test (新建集成测试)**：
   - 新建 `test/integration/safety-cascade-isolation.test.ts`，运行 `SessionContext + ApprovalService + HumanApprovalPlugin + NativeTool` 的端到端测试。
   - 覆盖场景一：并发双会话下，会话 A（YOLO 模式）与会话 B（Plan 模式）在并发调用命令时，其安全模式绝对物理隔离，互不穿透。
   - 覆盖场景二：在单个会话中挂起三个并发命令审批时，驳回其中任意一个导致级联熔断，验证其余两个自动取消释放，且 LLM 侧接收到结构化 `HaltedByReject` 异常。

## 业务能力

### 新增业务能力
<!-- 本次引入的新业务能力。若无则留空。 -->

### 修改业务能力
- `test-coverage`: 全面扩展安全工作模式（WorkMode）和多会话隔离特性的测试覆盖范围。

## 影响范围

- **受影响的系统模块**：
  - `test/action/terminal.test.ts` (追加 Unit 校验)
  - `test/brain/ApprovalService.test.ts` (追加 Unit 校验)
  - `test/action/tools.test.ts` (追加 Unit 校验)
  - 新建 `test/integration/safety-cascade-isolation.test.ts` (集成测试)
- **破坏性变更**：无。
