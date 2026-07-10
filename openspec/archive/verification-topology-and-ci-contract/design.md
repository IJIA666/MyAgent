# 设计：验证拓扑与 CI 契约

## 背景

当前验证体系存在四层断层：

1. **类型检查层**：生产 `tsconfig.json` 只包含 `src`，`test/tsconfig.json` 虽然已经存在，但 CI 从未执行它。
2. **单元层**：已有大量 Vitest 测试，但部分高风险 fixture 使用 `as unknown as ToolRegistryPort`，绕过了真实端口结构。
3. **合约/集成层**：`test/integration/` 由独立脚本运行，当前 CI 没有调用该脚本；编排器测试主要使用 mock 注册表，真实组合链路仍缺少验证。
4. **平台层**：终端、子进程、文件系统和浏览器适配器的测试文件位于扁平目录，当前 Ubuntu-only CI 没有 Windows 选择性门禁。

覆盖率依赖已安装，但 `vitest.config.ts` 没有启用 coverage。工具运行时实际位于 `src/adapters/tools/`，会话持久化实际由 `src/core/usecases/brain/ContextRepository.ts` 完成；日志实际由 `src/utils/logger.ts` 及 LogTape sink 提供。

## 目标与非目标

**目标：**

- 在 CI 中独立执行生产 `npm run build` 和测试 `npm run test:typecheck`。
- 保持 `npm test` 现有测试集合不变，并将其明确归入 L2。
- 将 `npm run test:integration` 和 `npm run test:contract` 纳入 Ubuntu 合并门禁。
- 为真实存在的关键路径配置 V8 coverage，并以基线和安全下限为依据设置按 glob 区分的 branch/statement 阈值。
- 在 `test/contract/` 下新增少量真实组合测试和完整类型 fixture，覆盖工具审批编排、会话快照和日志适配器。
- 在 Windows runner 上运行经过审计的显式平台敏感测试清单。
- 为四层验证拓扑建立贡献者文档和测试目录归属说明。

**非目标：**

- 不追求全仓库 100% 覆盖率，不为了阈值新增无业务价值的断言。
- 不把 `src/index.ts` 的启动副作用强行导入测试；如确需组合根测试，应在实现阶段先抽取无副作用的 composition function，并单独评估范围。
- 不新增真实 LLM、真实外部 MCP 或真实网络端到端测试。
- 不把现有 integration 测试未经依赖审计就改名为 hermetic contract 测试。
- 不虚构 `LoggerPort`、`Session.serialize()/deserialize()` 或 `src/persistence/` 等当前不存在的接口和目录。
- 不在 `package.json` 中写 JSON 不支持的注释字段。

## 架构决策

### 决策 1：测试类型检查作为独立 tsc 项目

**选型**：`tsc --noEmit -p test/tsconfig.json`

**理由**：根配置的 `include` 只覆盖生产源码，测试配置通过 `extends: "../tsconfig.json"`、`rootDir: ".."` 和 `include: ["**/*.ts"]` 将生产导入和测试文件放入同一个类型检查上下文。当前测试显式从 `vitest` 导入 API，因此 `compilerOptions.types` 维持 `node` 即可；只有未来使用全局 `describe` 等 API 时才增加 `vitest/globals`。

**边界**：`tsc` 可以拒绝对 `ToolMetadata` 调用未声明的属性，但不会自动禁止 `as unknown as` 双重断言。高风险 contract fixture 必须采用完整接口实现或 `satisfies ToolRegistryPort`；对双重断言的禁止需要通过 fixture 约定、lint 规则或 code review 明确落实，不能把责任虚假地归因于 tsc。

### 决策 2：各层使用同一 Vitest 配置，通过脚本指定目录或文件清单

**选型**：继续使用单个 `vitest.config.ts`，通过 npm script 的路径参数划分运行范围。

**理由**：当前是单包项目，不需要 Vitest workspace。`npm test` 继续运行现有 `test/core`、`test/adapters`、`test/common`、`test/config`；`test:contract`、`test:integration` 和 `test:platform:windows` 分别指定自己的测试范围。

### 决策 3：合约测试使用真实边界加最小确定性 fake

**选型**：真实使用 `ToolRegistry`、`BuiltinToolPolicyAdapter`、`HumanApprovalPlugin`、`ToolCallOrchestrator`、`ContextRepository` 和 `logger`；只对 LLM、交互决策、向量服务等外部依赖提供确定性 fake。

**理由**：当前 `HumanApprovalPlugin` 是具体类，安全评估入口是 `ToolPolicyPort.evaluate()`，不是 `ToolRegistryPort.getTool().checkSafety()`。当前也没有 `LoggerPort`；日志边界是 `src/utils/logger.ts`。测试应验证真实生产边界，不能为方便而创造一个不存在的接口。

**Fixture 规则**：`FakeToolRegistry` 必须完整实现 `ToolRegistryPort`；如果测试只需少量方法，应定义明确的最小端口，而不是把不完整对象通过 `as unknown as` 扩张为完整端口。

### 决策 4：覆盖率按真实路径和 glob 分组

**选型**：在 `test.coverage` 下使用 `provider: 'v8'`、真实文件 glob 和按 glob 区分的 `thresholds`；不使用 `perFile=true` 伪装目录聚合阈值。

**覆盖范围：**

- `src/core/domain/**/*.ts`
- `src/core/usecases/security/**/*.ts`
- 工具运行时的 `src/adapters/tools/ToolCatalog.ts`、`ToolExecutor.ts`、`ToolAccessMetadataProvider.ts`、`toolRegistry.ts`、`tool-factory.ts`、`builtin-tool-policy-adapter.ts`、`tool-policy-router.ts`
- `src/core/usecases/brain/ContextRepository.ts`

**阈值流程**：先运行不带阈值的报告并记录各 glob 的 statements/branches；如果低于约定安全下限，先补充有效测试；确认后再把实际数值写入对应 glob。阈值只能防回退，不得通过 `autoUpdate` 或无意义断言自动抬高。

### 决策 5：Ubuntu 全量门禁 + Windows 选择性阻塞门禁

**选型**：保留 Ubuntu `build-and-test` 作为 L1-L3 全量门禁，新增 Windows job 作为 L4 平台敏感测试门禁。

**理由**：当前测试文件不是按 `terminal/`、`browser/` 子目录组织，平台 job 必须使用经过审计的显式清单或匹配现有扁平文件名的 glob，例如 `test/adapters/tools/terminal.test.ts`、`test/adapters/tools/browser-*.test.ts`，不能使用当前仓库中匹配零文件的目录 glob。Windows job 默认阻塞合并；若未来引入按变更路径跳过的优化，必须保留明确的 changed-files 规则和审计日志。

## 风险与权衡

- **[首次类型检查暴露既有问题]**：新门禁可能暴露现有 fixture 的类型问题。→ 缓解：先修复高风险 contract fixture，再把测试类型检查设为阻塞步骤；不要用 `continue-on-error` 隐藏问题。
- **[覆盖率阈值误导]**：绝对值可能诱导无价值断言。→ 缓解：只覆盖关键真实路径，先生成可复现基线，阈值由人工确认并只用于防回退。
- **[Integration 环境依赖]**：现有集成测试可能需要子进程或工作区。→ 缓解：先逐文件审计；需要真实环境的测试仍标记为 integration，不把它们混入 contract fake 目录。
- **[Windows 执行时间]**：Playwright、子进程和终端测试会增加耗时。→ 缓解：只执行显式平台清单；不复制 core 纯逻辑测试。
- **[日志全局状态]**：`initLogger()` 使用全局 LogTape 配置和进程环境变量。→ 缓解：contract 测试使用隔离临时目录、受控环境变量和实际文件 sink，并在 teardown 中释放 logger 资源；不假设存在可注入的 `LoggerPort` 或 sink 接口。
