## 1. 新建配置管理模块

- [ ] 1.1 创建 `src/config.ts`，定义 `LlmConfig`、`McpServerEntry`、`McpConfig`、`AppConfig` 类型接口
- [ ] 1.2 实现 `ensureConfigFiles()` 函数：检查 `.env` 和 `mcp_config.json` 是否存在，缺失时从 `.example` 模板复制
- [ ] 1.3 实现 `requireEnv(name)` 函数：读取环境变量，缺失时抛出包含变量名的明确错误
- [ ] 1.4 实现 `interpolateEnvVars(value)` 函数：递归扫描配置值，将 `${VAR}` 占位符替换为 `process.env` 中的实际值
- [ ] 1.5 实现 `loadMcpConfig()` 函数：读取 `mcp_config.json`，解析 JSON 并调用插值函数
- [ ] 1.6 实现 `loadConfig()` 主入口函数：按序执行文件引导 → dotenv 加载 → 必填校验 → MCP 加载 → 对象冻结 → 返回 `AppConfig`

<!-- checkpoint: npx tsc --noEmit -->

## 2. 重构业务模块的配置消费方式

- [ ] 2.1 重构 `tools.ts`：删除模块顶层 `process.env` 读取，新增 `initWorkspace(rootDir)` 函数，在 `secureResolvePath()` 中添加未初始化防护检查
- [ ] 2.2 重构 `mcp-client.ts`：删除 `McpConfig`/`McpServerConfig` 接口定义（改为从 config.ts 导入），`McpToolManager` 构造函数改为接收 `McpConfig` 参数，将 `connectConfig()` 重命名为 `connectAll()` 并移除文件读取和三层合并逻辑
- [ ] 2.3 重构 `session.ts`：删除顶层 `dotenvConfig()` 调用，`SessionManager` 构造函数改为接收 `LlmConfig` 参数，移除 3 处 `process.env.DEEPSEEK_*` 读取和硬编码默认值
- [ ] 2.4 重构 `index.ts`：删除 `ensureConfigFilesExist()` 函数，在 `main()` 开头调用 `loadConfig()` 获取配置，通过构造函数参数将配置注入 `McpToolManager`、`SessionManager`，调用 `initWorkspace()`

<!-- checkpoint: npx tsc --noEmit -->

## 3. 更新配置模板与安全规则

- [ ] 3.1 更新 `.env.example`：统一 API URL 为 `https://api.deepseek.com`，新增 `TAVILY_API_KEY` 占位条目
- [ ] 3.2 更新 `mcp_config.example.json`：将 `TAVILY_API_KEY` 的值从 `"YOUR_API_KEY_HERE"` 改为 `"${TAVILY_API_KEY}"`
- [ ] 3.3 更新 `.gitignore`：新增 `mcp_config.json` 和 `mcp_config.local.json` 忽略规则

<!-- checkpoint: npx tsc --noEmit -->

## 4. 端到端验证

- [ ] 4.1 正常启动验证：执行 `npm run dev`，确认配置信息打印正确、REPL 正常启动
- [ ] 4.2 缺失配置验证：临时删除 `.env` 中的 `DEEPSEEK_API_KEY`，确认启动时报错信息清晰指向缺失变量
- [ ] 4.3 插值验证：在 `.env` 中配置 `TAVILY_API_KEY=test-key`，在 `mcp_config.json` 中使用 `"${TAVILY_API_KEY}"`，确认启动日志中显示已替换的值
- [ ] 4.4 代码清洁性验证：在 `src/` 目录下搜索 `process.env`，确认仅出现在 `config.ts` 中

<!-- checkpoint: npm run lint -->
