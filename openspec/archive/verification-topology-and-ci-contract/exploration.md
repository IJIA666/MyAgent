# 探索主题: 验证拓扑与 CI 契约

## 1. 问题定义

项目已有数量可观的单元测试，但“测试很多”不等于“关键架构边界可被证伪”。当前最突出的问题不是追求更高的总覆盖率数字，而是生产组合路径、测试代码类型检查、集成测试门禁和跨平台适配之间没有形成明确验证拓扑。统一工具运行时已经将内建工具的安全评估收敛到 `ToolPolicyPort`，但现有测试仍大量使用局部替身，尚未证明 `ToolRegistry`、`HumanApprovalPlugin` 与 `ToolCallOrchestrator` 的真实组合链路。需要建立按风险分层的验证契约，让测试能够发现边界错配，而不是增加更多同构 mock 测试。

## 2. 关键发现与调研结果

- **默认测试脚本不包含集成测试**：`npm test` 只运行 `test/core`、`test/adapters`、`test/common`、`test/config`；`test/integration` 由独立的 `test:integration` 脚本负责。
- **CI 没有调用集成脚本**：`.github/workflows/ci.yml` 在 Ubuntu 上执行 lint、生产构建、Playwright 安装和 `npm run test`，没有执行 `npm run test:integration`。当前三个集成测试文件实际上不属于合并门禁。
- **测试 TypeScript 未被 CI 显式检查**：根 `tsconfig.json` 只覆盖生产源码；仓库存在继承根配置的 `test/tsconfig.json`，但 CI 没有执行对应的 `tsc --noEmit -p test/tsconfig.json`。当前测试显式从 `vitest` 导入测试 API，因此不需要凭空添加 `vitest/globals`；若未来使用全局 API，才应同步加入该类型声明。Vitest 的运行时转译不能替代完整的测试类型契约检查。
- **覆盖率能力安装但未启用**：`@vitest/coverage-v8` 已在 devDependencies 中，`vitest.config.ts` 没有 coverage 配置，package scripts 和 CI 也没有 coverage 命令或 threshold。与此同时，`openspec/specs/test-coverage/spec.md` 要求核心服务达到“预设安全阈值”，但仓库中没有可执行阈值，规范无法验收。
- **关键组合入口没有测试**：`src/index.ts` 直接包含启动副作用，当前不适合作为可导入的 smoke 测试入口；生产组合根实际在其中创建 `ToolRegistry`、再将其 `policyPort` 和注册表传给 `SessionManager`。现有测试分别覆盖了审批插件组合、编排器局部逻辑和安全集成，但没有覆盖这条真实组合链路。
- **测试替身的类型安全被双重断言绕过**：`test/core/usecases/engine/tool-call-orchestrator.test.ts`、`test/adapters/tools/safety-and-concurrency.test.ts` 等文件使用 `as unknown as ToolRegistryPort`。`tsc` 能拒绝在 `ToolMetadata` 上调用不存在的属性，但不会自动禁止双重断言本身；高风险 contract fixture 必须使用完整实现或 `satisfies`，并通过明确的 lint/评审规则阻止该绕过。
- **状态持久化边界与制品原描述不一致**：`SessionManager` 暴露的是 `saveState()`/`loadState()`，实际 JSON 快照由 `src/core/usecases/brain/ContextRepository.ts` 写入和读取，没有 `Session.serialize()`/`deserialize()` API；快照也不包含审批历史记录字段。合约测试应验证实际持久化字段，不能虚构不存在的 API 或信息。
- **日志边界不是 `LoggerPort`**：仓库没有 `LoggerPort` 接口，实际边界是 `src/utils/logger.ts` 暴露的全局 `logger`、`initLogger()` 和 LogTape sink。日志合约测试必须围绕该真实适配器和测试 sink 设计。
- **工具运行时目录不是 `src/tool-registry/`**：工具目录、执行器和注册表位于 `src/adapters/tools/`；仓库没有 `src/persistence/`，会话快照位于 `src/core/usecases/brain/ContextRepository.ts`。
- **平台覆盖不对称**：项目包含 Windows shell、进程树清理、浏览器探测以及独立 Python monitoring server，CI 只有 Ubuntu。无需把所有测试复制到多平台，但终端、路径、进程和浏览器适配器的关键合同至少需要 Windows/Ubuntu 的选择性矩阵。
- **Vitest 官方能力核实**：Vitest 原生支持 V8 coverage 和按全局、glob 或 per-file 设置阈值；仓库已经安装相应 provider，缺的是配置和门禁，而不是新依赖。[Vitest Coverage 指南](https://main.vitest.dev/guide/coverage)、[Vitest CLI Coverage 配置](https://main.vitest.dev/guide/cli)
- **OpenClaw 对照**：OpenClaw 不只对策略函数做单测，还为 `before_tool_call` 提供 embedded-mode、integration 和 e2e 测试，覆盖真实审批路由缺失、策略阻断和调用标识传播。参考文件：`D:\projects\Agents\openclaw\src\agents\agent-tools.before-tool-call.embedded-mode.test.ts`、`agent-tools.before-tool-call.integration.e2e.test.ts`。

## 3. 方案对比与推荐方向

| 评估维度 | 方案 A：继续补局部单测 | 方案 B：所有场景改成端到端测试 | 方案 C：风险分层验证拓扑 | 结论 |
| :--- | :--- | :--- | :--- | :--- |
| 反馈速度 | 快 | 慢且易波动 | 单元层快，关键边界单独门禁 | C 平衡最好 |
| 发现端口错配 | 弱，mock 可绕过 | 强 | 通过契约测试和组合 smoke 精确发现 | C 更聚焦 |
| 故障定位 | 容易定位局部 | 困难 | 分层后可定位到类型、契约、集成或平台 | C 最清晰 |
| CI 成本 | 低但漏检 | 高 | 可按风险分 job、按平台选择运行 | C 可控 |
| 覆盖率价值 | 数字可能上升但无边界保证 | 难稳定统计 | 对安全与编排模块设分支阈值，其他模块只防回退 | C 不刷 KPI |

**推荐路径**：建立四层验证契约。第一层执行生产与测试 TypeScript 类型检查；第二层保留快速单元测试，并要求高风险端口 fixture 使用完整接口实现或 `satisfies`；第三层增加少量真实组合 contract/smoke 测试，优先覆盖工具策略、审批能力、`ContextRepository` 快照恢复和真实日志适配器；第四层把现有 integration 纳入 Ubuntu CI，并对终端、进程、文件系统和浏览器适配器建立显式的 Windows 选择性测试清单。覆盖率只在 `src/core/domain/`、`src/core/usecases/security/`、`src/adapters/tools/` 的工具运行时文件以及 `ContextRepository.ts` 等关键范围设置可解释的 branch/statement 基线，先记录可复现报告再设置“不得下降”的阈值，不把全仓 100% 当目标。

## 4. 约束、风险与未知项

- 本探索不主张立刻重写全部测试，也不主张把手工 testbed 纳入每次 CI；先覆盖高风险组合边界。
- integration 测试可能依赖本地配置或真实子进程，纳入 CI 前必须先拆清哪些是真集成、哪些应改成 hermetic contract 测试。
- Windows job 的 Playwright 和进程测试成本较高，推荐只运行平台敏感文件，不复制完整测试套件。
- 覆盖率阈值必须基于当前可复现报告制定；规范中的“预设安全阈值”需要给出具体目录、指标和数值，否则仍不可验收。
- 生产组合 smoke 应避免调用真实模型或外部服务，可在真实注册表和真实策略适配器上注入确定性的 `LlmPort`、交互决策和向量服务 fake；审批插件本身是具体类，不应伪造不存在的 `HumanApprovalPlugin` 接口。
- `src/index.ts` 当前直接包含启动副作用。若难以测试，后续变更可抽取无副作用的 composition function，但不能为了测试引入新的服务定位器。

## 5. 否决方案

- **只提高测试文件数量**：否决。数量不能修复不真实的替身和缺失的组合门禁。
- **全仓强制 100% 覆盖率**：否决。会诱导无价值断言和忽略关键分支，违背本次实事求是的目标。
- **仅依赖 Vitest 运行成功替代测试类型检查**：否决。运行时转译无法证明端口替身满足 TypeScript 契约。
- **把所有集成和浏览器测试塞进单一 CI job**：否决。反馈慢、定位差，且平台问题会污染纯逻辑验证。
- **继续允许高风险 contract fixture 使用 `as unknown as` 扩张端口能力**：否决。应改为真实实现、`satisfies` 或只暴露所需最小端口的受控 fixture；普通单元测试的既有替身是否迁移，应以实际类型风险逐项判断。
