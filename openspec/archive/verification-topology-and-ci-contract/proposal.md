# 验证拓扑与 CI 契约

## Why

项目已积累数量可观的自动化测试，但测试覆盖存在结构性盲区：生产组合路径、测试代码类型检查、集成测试门禁、覆盖率门禁和跨平台适配没有形成可验收的验证拓扑。当前的主要问题不是测试数量不足，而是局部替身可能绕过真实端口，且关键验证没有进入合并门禁。

本次变更不把当前代码中的旧测试替身误判为生产契约，也不把不存在的 `LoggerPort`、`Session.serialize()` 或 `src/persistence/` 目录写入设计。所有新增验证都以当前真实边界为准：工具运行时位于 `src/adapters/tools/`，会话快照由 `ContextRepository` 管理，日志由 `src/utils/logger.ts` 管理。

## What Changes

1. **新增测试类型检查门禁**：增加 `npm run test:typecheck`，在 Ubuntu CI 中独立执行 `tsc --noEmit -p test/tsconfig.json`。`npm test` 的现有测试集合保持不变，提交前的推荐验证顺序写入贡献指南。
2. **建立四层验证拓扑**：将生产/测试类型检查、快速单元测试、contract/integration 测试和平台敏感测试分别定义为 L1-L4，并为每层指定命令、责任边界和 CI 位置。
3. **集成测试纳入 CI**：在 Ubuntu 合并门禁中执行现有的 `npm run test:integration`，先保持其真实依赖边界，不把它误标成 hermetic contract 测试。
4. **启用覆盖率门禁**：为 Vitest 配置 V8 coverage，使用真实存在的核心目录和文件 glob。先生成可复现基线；若目标范围低于约定的安全下限，先补充有效测试，再把实际确认的数值写入按 glob 区分的 thresholds。不得通过全仓高阈值或无意义断言刷数字。
5. **补充高风险组合合约测试**：新增少量 contract 测试，覆盖 `ToolRegistry` 的真实内建工具、`ToolPolicyPort`、`HumanApprovalPlugin`、`ToolCallOrchestrator` 的组合链路；覆盖 `ContextRepository.saveState()`/`loadState()` 的实际快照字段；覆盖 `src/utils/logger.ts` 的结构化输出和级别过滤。测试不调用真实 LLM、网络服务或外部 MCP 服务器。
6. **建立选择性 Windows 门禁**：新增 `test:platform:windows` 脚本，通过经过审计的显式文件清单运行终端、进程、文件系统、浏览器和 MCP 子进程相关测试。不能使用当前仓库不存在的 `test/adapters/**/terminal/**`、`test/adapters/**/browser/**` 作为唯一筛选条件。
7. **文档化验证拓扑**：新增 `CONTRIBUTING.md` 和 `test/README.md`，说明 L1-L4 的职责、命令、门禁位置、测试目录归属和失败处理方式。`package.json` 保持合法 JSON，不添加伪造的 `//` 注释字段。

## Capabilities

### New Capabilities

- `test-type-check`：独立的测试代码 TypeScript 类型检查门禁。
- `contract-testing`：围绕真实工具注册、审批编排、会话快照和日志适配器的合约测试。
- `ci-platform-matrix`：Ubuntu 全量验证加 Windows 平台敏感测试选择性门禁。
- `test-verification-topology`：按 L1-L4 组织验证活动的分层契约。

### Modified Capabilities

- `test-coverage`：把原先抽象的覆盖率要求改为真实路径、可执行的 glob 阈值和基线流程。

## Impact

- **CI 流程**：`.github/workflows/ci.yml` 增加测试类型检查、覆盖率、集成测试和 Windows 平台测试步骤。
- **测试配置**：`vitest.config.ts` 增加 V8 coverage 的真实 include 范围和按 glob 的 thresholds；`package.json` 增加独立脚本。
- **测试文件**：新增 `test/contract/` 下的受控 fixture 和合约测试，并按审计结果维护平台测试清单。
- **文档**：新增 `CONTRIBUTING.md` 和 `test/README.md`。
- **开发工作流**：`npm test` 默认测试集合不变；提交前应先执行 `npm run build`、`npm run test:typecheck`、`npm test`、`npm run test:contract` 和 `npm run test:integration`。
- **平台依赖**：Windows job 只安装和运行其清单所需的 Playwright/进程测试依赖，并作为阻塞性平台门禁执行。
