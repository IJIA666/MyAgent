## 1. 单元测试补充 (组件级防护)

- [x] 1.1 修改 `test/action/terminal.test.ts`，追加 Plan 模式拦截写命令、以及毁灭级命令底线拦截的单元测试用例。
- [x] 1.2 修改 `test/brain/ApprovalService.test.ts`，追加 `rejectBySessionId` 批量熔断及 sessionId 并发隔离验证的单元测试用例。
- [x] 1.3 修改 `test/action/tools.test.ts`，追加 `ReadFileTool`、`WriteFileTool`、`EditFileTool` 对 `.env` 等敏感文件执行 YOLO 降级 Safe 卡关与明文/Diff 披露的单元测试用例，并确保 `.env.example` 的自由放行。

<!-- checkpoint: npm run test -->

## 2. 集成测试新建 (跨组件联动与并发隔离)

- [x] 2.1 在 `test/integration/` 下创建 `safety-cascade-isolation.test.ts` 测试文件。
- [x] 2.2 在该集成测试文件中搭建完整的 `SessionContext + ApprovalService + HumanApprovalPlugin + NativeTool` 的联调运行测试环境。
- [x] 2.3 编写测试用例验证 YOLO 与 Plan 会话并发下的工作模式绝对物理隔离，验证命令执行互不穿透污染。
- [x] 2.4 编写测试用例验证多任务审批被驳回时的会话级级联熔断，验证其余任务被释放并抛出 `HaltedByReject` 异常。

<!-- checkpoint: npm run test -->
