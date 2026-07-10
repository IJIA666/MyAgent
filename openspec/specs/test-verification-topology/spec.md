## ADDED Requirements

### Requirement: 四层验证拓扑的组织规范

系统必须（MUST）将验证活动组织为四个明确层次，每层承担不同职责并对应独立的执行门禁：

1. **L1 — 类型检查层**：验证生产代码和测试代码的 TypeScript 类型契约；
2. **L2 — 单元测试层**：验证单个模块的逻辑正确性；
3. **L3 — 合约/集成层**：验证跨模块真实装配和集成约束；
4. **L4 — 平台层**：验证平台敏感适配器在目标操作系统上的行为。

#### Scenario: 各层的 CI 门禁嵌入

- **WHEN** CI 流水线执行时
- **THEN** L1 必须（MUST）执行生产构建和测试类型检查，L2 执行 `npm test`，L3 执行 `npm run test:contract` 与 `npm run test:integration`，L4 在 Windows runner 上执行 `npm run test:platform:windows`；每层失败都必须阻塞对应门禁。

#### Scenario: 失败层级标识

- **WHEN** 任一层的验证失败
- **THEN** CI step 名称和输出必须（MUST）使用 `[L1]`、`[L2]`、`[L3]` 或 `[L4]` 前缀，帮助定位问题属于类型、单元、合约/集成还是平台层。

### Requirement: 验证层的扩展性

验证拓扑应当（SHALL）允许在不修改既有层级语义的前提下向合适层级添加验证项。

#### Scenario: 新增验证项

- **WHEN** 开发者需要为模块添加新的检查或测试
- **THEN** 只需将测试放入 `test/`、`test/contract/`、`test/integration/` 或平台清单对应位置，或扩展既有 tsc 配置范围，不得复制一套新的 CI 层级编排。

### Requirement: 验证拓扑的文档化

验证拓扑的层级定义、门禁标准和职责必须（MUST）在项目文档中以结构化形式记载。

#### Scenario: 验证拓扑文档

- **WHEN** 开发者阅读 `CONTRIBUTING.md` 或 `test/README.md`
- **THEN** 文档必须（MUST）说明四层职责、触发命令、CI 位置、测试目录归属和失败处理方法。
