## 改造原因

虽然目前系统已经拥有一套健壮的单元测试（Mock环境）来校验配置加载逻辑，但是在真实物理系统边界上，依然缺乏系统集成层面的自动化防退化手段：
1. **物理配置引导与热读写冲突**：没有自动化用例确保在物理磁盘上 `.env` 和 `mcp_config.json` 真实存在、缺失及格式异常时的动态行为符合预期。
2. **真实的 MCP 进程环境变量隔离安全**：目前的环境变量隔离仅在单元测试中通过 Mock 字典进行逻辑断言，并没有在操作系统级别通过真实 `spawn` 子进程来审计环境变量的物理隔离与防泄露机制。

为了进一步加固系统的安全防线，我们需要在工程中搭建起轻量级、物理级别的**集成测试（Integration Testing）**框架，并补齐这两个核心场景的集成测试用例。

## 变更内容

本变更属于测试工程底座的建设，不涉及对任何已有业务运行逻辑的修改（No BREAKING changes），具体变更如下：
1. **集成测试框架搭建**：在 `test/` 目录下物理新建 `integration/` 目录，存放物理隔离的集成测试用例。
2. **测试脚本隔离**：为 Vitest 增加集成测试运行脚本，避免将磁盘读写和子进程启动的慢速集成测试引入到日常的快速单元测试（`npm run test`）中，确保日常开发效率。
3. **补齐核心集成用例**：
   - 物理配置引导集成用例：使用临时工作空间目录（Temporary Workspace）物理写入 `.env`、修改参数、删除物理配置文件，验证 `ensureConfigFiles()` 的文件生成，并检查 `loadConfig()` 加载物理文件时的字段正确性。
   - MCP 子进程环境变量隔离集成用例：真实拉起一个 Dummy 子进程（打印自身的 `process.env`），捕获并解析其输出，从操作系统级别物理审计敏感变量（如 `AGENT_LLM_API_KEY`）确实没有泄露到子进程。

## 业务能力

### 新增业务能力
- 无：本次不引入新的产品功能性业务能力。

### 修改业务能力
- `unit-testing-setup`: 扩展并搭建轻量级集成测试框架，为物理 IO 和子进程环境安全追加集成级别测试用例。

## 影响范围

- **测试代码目录**：
  - 新增 [test/integration/](file:///d:/Projects/MyAgent/test/integration) 目录。
  - 新增 `test/integration/config-guide.spec.ts` 物理配置集成测试。
  - 新增 `test/integration/mcp-isolation.spec.ts` 物理进程隔离集成测试。
- **项目配置**：
  - [package.json](file:///d:/Projects/MyAgent/package.json)（添加 `npm run test:integration` 测试脚本）。
