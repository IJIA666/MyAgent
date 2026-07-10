## ADDED Requirements

### Requirement: 测试代码独立的 TypeScript 类型检查门禁

系统必须（MUST）在本地开发流程和 CI 流水线中为测试代码提供独立的 TypeScript 类型检查门禁，确保测试代码对生产接口的引用满足完整的类型契约。

#### Scenario: 独立的测试类型检查脚本

- **WHEN** 开发者在本地执行 `npm run test:typecheck`
- **THEN** 系统必须（MUST）执行 `tsc --noEmit -p test/tsconfig.json`，并在类型不匹配时以非零退出码终止。

#### Scenario: CI 流水线集成测试类型检查

- **WHEN** CI 工作流执行时
- **THEN** Ubuntu job 必须（MUST）在生产 `npm run build` 之后或并行步骤中执行一次 `npm run test:typecheck`，任一测试文件的类型错误均使该步骤失败。

#### Scenario: 高风险端口 fixture 的结构约束

- **WHEN** `test/contract/` 中创建 `ToolRegistryPort` 等高风险端口 fixture
- **THEN** fixture 必须（MUST）使用完整接口实现或 `satisfies` 进行结构校验，不得使用 `as unknown as` 将缺少方法的对象扩张为完整端口；该规则由 fixture 约定、lint 或 code review 共同保证，不能声称仅靠 tsc 自动禁止所有双重断言。

### Requirement: 测试 tsconfig 引用生产源码路径

测试代码的 `test/tsconfig.json` 必须（MUST）继承根生产配置并包含所有 `test/**/*.ts` 文件，使测试代码能够解析并检查对 `src` 生产接口的引用。

#### Scenario: tsconfig 路径配置

- **WHEN** 执行 `tsc --noEmit -p test/tsconfig.json`
- **THEN** `test/tsconfig.json` 必须（MUST）通过 `extends: "../tsconfig.json"` 或等价的 `paths`/project 配置解析生产源码，并包含测试文件；只有测试使用 Vitest 全局 API 时才配置 `vitest/globals`。

### Requirement: 测试类型检查的提交前使用约定

系统应当（SHALL）在贡献者文档中明确测试类型检查与单元测试的执行关系；本次变更不改变 `npm test` 的默认测试文件集合。

#### Scenario: 提交前验证顺序

- **WHEN** 开发者准备提交代码前执行验证
- **THEN** `CONTRIBUTING.md` 必须（MUST）要求先执行 `npm run build` 和 `npm run test:typecheck`，再执行 `npm test`，并说明三者失败时的处理方式。
