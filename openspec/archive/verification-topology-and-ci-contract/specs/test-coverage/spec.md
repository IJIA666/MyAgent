## MODIFIED Requirements

### 需求: 核心服务覆盖率指标

系统底层核心服务的单元测试覆盖率必须（MUST）满足可执行的安全阈值，以确保关键底座的高可靠性；阈值按真实源码 glob 配置，不以不存在的目录名表达。

#### Scenario: 覆盖率校验与断言

- **WHEN** 执行 `npm run test:coverage` 并收集 V8 coverage 报告
- **THEN** 以下真实范围的 Statement 和 Branch 覆盖率必须（MUST）达到配置的安全下限：
  - `src/core/domain/**/*.ts` — statements ≥ 80%，branches ≥ 70%；
  - `src/core/usecases/security/**/*.ts` — statements ≥ 75%，branches ≥ 65%；
  - 工具运行时的 `ToolCatalog.ts`、`ToolExecutor.ts`、`ToolAccessMetadataProvider.ts`、`toolRegistry.ts`、`tool-factory.ts`、`builtin-tool-policy-adapter.ts`、`tool-policy-router.ts` — statements ≥ 70%，branches ≥ 60%；
  - `src/core/usecases/brain/ContextRepository.ts` — statements ≥ 65%，branches ≥ 55%。

#### Scenario: 覆盖率阈值首次设置流程

- **WHEN** 首次在 `vitest.config.ts` 中启用 coverage thresholds
- **THEN** 必须（MUST）先运行不带阈值的 coverage 报告，核对每个真实范围的当前数值；若低于上述安全下限，先补充能够证明行为的测试，再将确认后的数值写入对应 glob，严禁随意降低安全下限或依赖 `autoUpdate` 自动修改阈值。

#### Scenario: 覆盖率门禁在 CI 中的集成

- **WHEN** CI Ubuntu job 运行 `npm run test:coverage`
- **THEN** 任一范围未达标时 coverage step 必须（MUST）以非零退出码终止，并报告未达标的源码 glob 和指标。
