# 探索主题: 安全工作模式与会话隔离专项测试补充

## 1. 问题定义
本次重构重塑了智能体的安全机制（包括多会话物理隔离、Plan 只读模式、毁灭性命令底线拦截、级联审批安全熔断及机密敏感文件分级保护审计）。虽然重构后现有的 77/77 个测试全部成功通过，但新功能在现有测试套件中的覆盖率为 0。需要为这些新核心能力提供可靠、完整的测试覆盖。

## 2. 关键发现与调研结果
- **代码库现状**：
  - `test/action/terminal.test.ts` 仅测试了默认 YOLO 模式和白名单匹配，未覆盖 Plan 模式和底线黑名单拦截。
  - `test/brain/ApprovalService.test.ts` 仅覆盖了常规 wait/resolve/reject，未覆盖 `rejectBySessionId` 级联熔断及多会话隔离。
  - `test/action/tools.test.ts` 未覆盖 `ReadFileTool`、`WriteFileTool`、`EditFileTool` 对机密敏感文件（`.env`）降级到 `Safe` 并提取明文及 Diff 差分展示的安全防护逻辑。
- **核实与洞察**：
  - 为实现对新设计的完备防卫，测试用例必须覆盖 YOLO 模式下对绝对危险指令的底线拦截、Plan 模式对副作用操作的拦截、多会话并发下的 `workMode` 互不污染、审批级联熔断时抛出带有 `HaltedByReject` 错误、以及读写机密文件时的分级降级审批。

## 3. 方案对比与推荐方向
| 评估维度 | 方案 A (纯 Unit) | 方案 B (纯 Integration) | 方案 C (Unit + Integration 分层测试) | 结论 |
| :--- | :--- | :--- | :--- | :--- |
| **测试就近内聚性** | 强 ✓ | 弱 ✗ (脱离原文件) | 强 ✓ (原子逻辑就近内聚) | 方案 C 占优 |
| **排查定位成本** | 低 ✓ (精准单测) | 高 ✗ (链路长) | 低 ✓ (分层清晰，小错看单测，大错看集成) | 方案 C 占优 |
| **复杂链路覆盖率** | 弱 ✗ (无法测试并发隔离) | 强 ✓ | 强 ✓ (高价值端到端场景覆盖) | 方案 C 占优 |

**推荐路径**：采用 **方案 C (分层测试 Unit + Integration 融合)**，具体如下：

1. **组件级 Unit Test (就近补充)**：
   - 在 `test/action/terminal.test.ts` 中追加：只读 `Plan` 模式对写命令的拦截测试；底线黑名单 `rm -rf` 的绝对拦截测试。
   - 在 `test/brain/ApprovalService.test.ts` 中追加：`rejectBySessionId` 能否正确根据 sessionId 批量清理挂起审批的单元测试。
   - 在 `test/action/tools.test.ts` 中追加：传入敏感凭据文件（`.env` 等）时，安全卡关拦截并返回 `suspend` 的测试。

2. **端到端 Integration Test (新建集成测试)**：
   - 新建 `test/integration/safety-cascade-isolation.test.ts`。搭建 `SessionContext + ApprovalService + HumanApprovalPlugin + NativeTool` 的全套运行环境，编写两个高价值场景：
     - 模拟并发会话，验证会话 A 的 YOLO 模式与会话 B 的 Plan 模式在执行命令时互不干扰，安全模式绝对物理隔离。
     - 模拟在单个会话中挂起三个操作，其中一个触发 deny，验证其余挂起任务是否被 `HaltedByReject` 级联熔断中止。

## 4. 约束、风险与未知项
- **测试沙箱干扰**：测试中会读写测试用的 `.env` 机密文件，需在 `beforeEach`/`afterEach` 中对测试生成的文件进行清理，避免污染本地工作区。
- **并发异步超时**：级联熔断测试涉及多个异步 `wait` 的控制，需要精确使用 Promise 控制唤醒时序。

## 5. 否决方案
- **纯集中新建方案 (方案 B)**：把原子校验（如正则拦截、文件路径鉴别、基础数据结构清理）全部移出原有组件单测文件，造成单测防线失效，且问题定位链路过长，为了“省事”而违背了测试内聚性原则。
