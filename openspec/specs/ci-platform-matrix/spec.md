## ADDED Requirements

### Requirement: CI 跨平台选择性门禁

CI 流水线必须（MUST）在 Ubuntu 上运行完整验证，在 Windows 上运行经过审计的平台敏感测试集合，确保跨平台适配器的行为得到阻塞性验证。

#### Scenario: Ubuntu 平台运行完整验证

- **WHEN** CI 流水线被触发
- **THEN** Ubuntu runner 必须（MUST）执行 lint、生产构建、测试类型检查、单元测试、覆盖率、集成测试和合约测试，并在所有步骤成功后报告成功状态。

#### Scenario: Windows 平台运行平台敏感测试子集

- **WHEN** CI 流水线被触发
- **THEN** Windows runner 必须（MUST）通过 `npm run test:platform:windows` 运行显式的平台测试清单，不得复制完整测试套件；清单至少覆盖实际存在的终端 `test/adapters/tools/terminal.test.ts` 和浏览器 `test/adapters/tools/browser-*.test.ts`，并按审计结果加入输入、文件系统、进程或 MCP 子进程测试。

#### Scenario: 平台敏感测试的文件命名约定

- **WHEN** 开发者创建需要在跨平台 job 中运行的平台敏感测试文件
- **THEN** 新测试必须（MUST）遵循 `*.platform.test.ts`；仅限 Windows 的测试使用 `*.windows.test.ts`。既有扁平文件由 npm 清单显式维护，不得依赖不存在的 `terminal/` 或 `browser/` 子目录 glob。

#### Scenario: Windows job 失败处理

- **WHEN** Windows 平台敏感测试失败
- **THEN** Windows job 必须（MUST）返回非零退出码并阻塞合并；不得用 `continue-on-error: true` 将平台适配回归隐藏为成功。
