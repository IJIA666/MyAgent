## 1. 配置层扩展 (Config Layer Development)

- [x] 1.1 修改 `.env.example` 补充新增的 5 项运行限制环境变量参数说明
- [x] 1.2 修改 `src/config/types.ts` 中的 `AppConfig` 接口，追加新增的 5 个参数限制配置定义
- [x] 1.3 修改 `src/config/loader.ts` 中的 `loadConfig()`，支持这 5 项环境变量的安全解析（类型转换与 NaN 校验）和深度冻结

<!-- checkpoint: npm run build -->

## 2. 上下文依赖注入与思考上限控制 (Context & Agent Loop Adaptation)

- [x] 2.1 修改 `src/brain/context.ts` 的 `SessionContext`，为其新增 `public appConfig?: AppConfig` 属性
- [x] 2.2 修改 `src/brain/session.ts`，重构构造函数以接收 `appConfig`，将其挂载到 `this.context.appConfig` 上，并将 `maxIterations` 参数传递给 `AgentLoop` 构造函数
- [x] 2.3 修改 `src/brain/agent-loop.ts` 构造函数，利用配置参数覆盖硬编码的思考迭代大循环轮数限制

<!-- checkpoint: npm run build -->

## 3. 工具与中间件插件逻辑适配 (Tools & Middleware Modification)

- [x] 3.1 修改 `src/brain/services/ToolDispatcher.ts`，使大文本拦截自动落盘机制动态消费 `largeToolOutputLimit` 限制数
- [x] 3.2 修改 `src/brain/plugins/TokenWatermarkPlugin.ts`，使 Token 水位限制动态消费 `compactionWatermarkFactor` 阈值比例
- [x] 3.3 修改 `src/action/tools/filesystem/read-many-files.ts` 的 `execute` 方法，动态消费 `readManyFilesLimit` 体积限制
- [x] 3.4 修改 `src/action/tools/filesystem/search.ts` 中的 `GrepSearchTool` 与 `GlobSearchTool` 的 `execute` 方法，动态消费 `searchLimit` 文件展示限制

<!-- checkpoint: npm run build -->

## 4. 验证测试与验收 (Testing and Verification)

- [x] 4.1 运行单元测试以核实无向后兼容性崩溃问题
- [x] 4.2 编写或扩展相关的配置与注入单测，并验证其执行表现

<!-- checkpoint: npm run test -->

## 5. 配置注释与分类整理 (Config Documentation & Classification) [调试修正]

- [x] 5.1 修正 `.env.example` 中 `AGENT_LLM_MAX_TOKENS` 的单位标注（Tokens）
- [x] 5.2 整理并重构 `.env.example`，对全部配置项进行大分类排序与注释美化
- [x] 5.3 运行单元测试（`npm run test`）和构建（`npm run build`），确保环境配置文件格式的改动没有对程序及现有测试造成不良影响

<!-- checkpoint: npm run test -->
