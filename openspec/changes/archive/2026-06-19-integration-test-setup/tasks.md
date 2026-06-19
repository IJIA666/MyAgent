## 1. 集成测试工程基建与配置测试

- [x] 1.1 修改 `package.json`，在 `scripts` 中新增 `"test:integration": "vitest run test/integration"` 集成测试专用命令。
- [x] 1.2 新增 `test/integration/config-guide.spec.ts` 集成测试文件。在临时目录沙箱 `test-temp-integration-workspace` 中物理读取、修改、删除 `.env` 和 `mcp_config.json`，验证 `ensureConfigFiles()` 自生成与 `loadConfig()` 物理加载装配的链路。

<!-- checkpoint: npm run build -->

## 2. MCP 真实子进程环境变量物理隔离集成测试

- [x] 2.1 新增 `test/integration/mcp-isolation.spec.ts` 集成测试文件。
- [x] 2.2 编写物理子进程环境变量拦截单测。动态写入 Dummy Node.js 自检脚本，以真实 OS 的 `spawn` 方式启动该子进程，通过模拟环境变量注入并捕获其 stdout，物理断言敏感大模型密钥（如 `AGENT_LLM_API_KEY`）确实被完全过滤，且 `PATH` 等白名单变量成功透传。

<!-- checkpoint: npm run build && npm run test && npm run test:integration -->
