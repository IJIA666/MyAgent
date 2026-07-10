# 实施任务

## 1. 基础工具链配置

- [x] 1.1 在 `package.json` 的 `scripts` 中新增：
  - `"test:typecheck": "tsc --noEmit -p test/tsconfig.json"`
  - `"test:coverage": "vitest run --coverage test/core test/adapters test/common test/config test/contract"`
  - `"test:contract": "vitest run test/contract"`
  - `"test:platform:windows": "vitest run test/adapters/tools/terminal.test.ts test/adapters/tools/browser-detector.test.ts test/adapters/tools/browser-action.test.ts test/adapters/tools/browser-action-multitenant.test.ts test/adapters/tools/mcp-client.test.ts"`
- [x] 1.2 在 `vitest.config.ts` 的 `test.coverage` 中启用 `provider: 'v8'`，配置 `reporter: ['text', 'html', 'lcov']`，并使用真实存在的文件 glob：`src/core/domain/**/*.ts`、`src/core/usecases/security/**/*.ts`、工具运行时明确文件、`src/core/usecases/brain/ContextRepository.ts`。
- [x] 1.3 确认 coverage 的 `thresholds` 使用与 include 对应的 glob 键，不使用 `perFile=true` 代替目录阈值；在基线完成前不写入猜测数值。

<!-- checkpoint: npm run build -->

## 2. 测试类型检查门禁

- [x] 2.1 审计 `test/tsconfig.json`：确认它继承根配置、包含 `test/**/*.ts`、能够解析 `src` 导入；当前测试显式导入 `vitest`，不为不存在的全局用法添加 `vitest/globals`。
- [x] 2.2 执行 `npm run test:typecheck`，修复真实发现的类型错误；重点审计 `test/core/usecases/engine/tool-call-orchestrator.test.ts`、`test/adapters/tools/safety-and-concurrency.test.ts` 等高风险 fixture，移除不必要的 `as unknown as ToolRegistryPort`。
- [x] 2.3 对新增 `test/contract/` fixture 使用 `satisfies` 或完整接口实现；对确需双重断言的既有普通单元测试逐项说明原因，不把”运行 tsc”误写成自动禁止双重断言。
- [x] 2.4 在 `.github/workflows/ci.yml` 中新增 `[L1] Run Test Type Check`，执行 `npm run test:typecheck`，并保持 `npm test` 默认测试集合不变。

<!-- checkpoint: npm run test:typecheck -->

## 3. 覆盖率基线与门禁

- [x] 3.1 先执行不带阈值的 coverage 报告，记录上述真实 glob 的 statements 和 branches 数值及报告文件位置。
- [x] 3.2 将每个范围与安全下限比较：`src/core/domain/**/*.ts` 达到 89.66/77.74，`src/core/usecases/security/**/*.ts` 达到 88.28/76，工具运行时明确文件和 `ContextRepository.ts` 均已达到对应 glob 阈值，不再存在阈值覆盖缺口。
- [x] 3.3 将确认后的实际阈值写入 `vitest.config.ts`，使用与 `coverage.include` 对应的 glob thresholds，避免不同关键目录之间的覆盖率差异被单一全局数字掩盖；不使用 `perFile=true` 伪装目录阈值，也不写入未经验证的猜测数字。
- [x] 3.4 执行 `npm run test:coverage`，确认阈值通过（本次实际汇总覆盖率为 88.87% statements / 76.8% branches，有效范围均达到对应 glob 阈值）。
- [x] 3.5 在 Ubuntu CI 增加 `[L2] Run Coverage`，执行 `npm run test:coverage`；coverage 失败必须阻塞 job。

<!-- checkpoint: npm run test:coverage -->

## 4. 合约测试框架

- [x] 4.1 创建 `test/contract/fakes/`，提供 FakeLlmPort（完整 LlmPort 实现）；FakeToolRegistry 暂不需要（合约测试使用真实 ToolRegistry）。
- [x] 4.2 编写 `test/contract/tool-call-orchestration.test.ts`：使用真实 `ToolRegistry`、`PluginRegistry`、`ToolDispatcher`、`ApprovalEffectApplier` 和 `ToolCallOrchestrator`，注入确定性策略端口，验证 deny 阻断和 pass 正常执行。
- [x] 4.3 编写 `test/contract/session-persistence.test.ts`：构造 `ContextRepository`，验证 `saveState()` → JSON 快照 → `loadState()` 的 `messages`、`checkpointSummary`、`recentFiles` 无损恢复。
- [x] 4.4 编写 `test/contract/log-pipeline.test.ts`：使用真实 `initLogger()`、结构化属性和 LogTape 文件 sink 验证 JSONL 输出；使用临时工作目录和受控环境变量，teardown 调用 `disposeLogger()`。
- [x] 4.5 执行 `npm run test:contract`，确认不调用真实 LLM、网络、外部 MCP 或不可控进程。

<!-- checkpoint: npm run test:contract -->

## 5. 集成测试纳入 CI

- [x] 5.1 在 Ubuntu `build-and-test` job 增加 `[L3] Run Integration Tests`，执行 `npm run test:integration`。
- [x] 5.2 逐个审计 `test/integration/` 的环境依赖；当前 integration 测试无需 `xvfb-run` 前缀。
- [x] 5.3 在 CI 中确保 `[L3] Run Contract Tests` 执行 `npm run test:contract`，并与 unit/integration 的失败状态一样阻塞 job。

<!-- checkpoint: 检查 workflow YAML 语法 -->

## 6. Windows 平台门禁

- [x] 6.1 审计平台敏感实现与测试：已核对终端、浏览器、MCP 子进程，生成显式测试清单。
- [x] 6.2 既有测试不做重命名（平台清单使用显式文件路径而非 glob，不依赖目录扫描）。未来新增平台敏感测试按 `*.platform.test.ts` 命名。
- [x] 6.3 在 `package.json` 中将 `test:platform:windows` 指向 6.1 的清单；在 `.github/workflows/ci.yml` 新增 `platform-windows` job，使用 `windows-latest`，安装所需 Playwright 浏览器，并执行 `[L4] Run Windows Platform Tests`。
- [x] 6.4 Windows job 默认作为阻塞性门禁，不设置 `continue-on-error: true`；若后续要引入 changed-files 跳过优化，必须同时补充触发规则测试和跳过原因日志。

<!-- checkpoint: 检查 workflow YAML 语法并验证 Windows 清单至少匹配一个文件 -->

## 7. 验证拓扑文档化

- [x] 7.1 新增 `CONTRIBUTING.md` 的”验证拓扑”章节，使用表格列出 L1-L4 的职责、执行命令、CI job/step 和失败处理方式。
- [x] 7.2 新增 `test/README.md`，说明 `core/`、`adapters/`、`integration/`、`contract/`、`helpers/`、`manual/` 和 `scripts/` 的用途及层级归属。
- [x] 7.3 在 `CONTRIBUTING.md` 的验证拓扑表中说明各脚本的层级归属；不在 JSON 中添加 `//` 注释字段。

<!-- checkpoint: npm run build && npm run test:typecheck -->
