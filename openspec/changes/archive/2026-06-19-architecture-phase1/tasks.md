# 架构重构第一期：Brain 状态与持久化解耦、配置依赖注入改造

第一期重构的目标是将 `SessionContext` 退化为纯内存会话状态容器，剥离其与物理 IO、全局安全命令白名单的管理纠缠，并对全局配置加载器 `loadConfig` 进行依赖注入与无副作用改造。

## 1. 核心状态容器纯粹化

- [x] 1.1 修改 `src/brain/context.ts`，彻底移除所有 `fs` 和 `path` 的导入依赖。
- [x] 1.2 在 `SessionContext` 中删除物理落盘与加载方法：`saveState()` 和 `loadState()`。
- [x] 1.3 在 `SessionContext` 中删除 `securityAllowlist` 属性及其关联的存取方法：`loadSecurityAllowlist`、`saveSecurityAllowlist`、`getSecurityAllowlist`。
- [x] 1.4 在 `SessionContext` 中确保存在 `updateHistory(history: ChatCompletionMessageParam[])` 方法以供覆盖消息历史，同时增补 `setSessionId(id: string)` 方法，以供在恢复状态时重新绑定标识。

<!-- checkpoint: npm run build -->

## 2. 状态持久化下沉与安全服务独立剥离

- [x] 2.1 新建 `src/brain/services/SecurityService.ts`，实现一个独立的全局安全单例类，接管对 `.agent/allowed_commands.json` 磁盘文件的读取、内存缓存与持久化写入。
- [x] 2.2 修改 `src/brain/services/ContextRepository.ts`，引入 `fs/promises` 和 `path` 依赖，重写 `saveState` 与 `loadState`。`saveState` 从 `this.context` 提取 history 等数据并序列化写入 `.myagent/sessions`；`loadState` 读取 JSON 并在 `this.context` 上调用 setter 恢复状态。
- [x] 2.3 修改 `src/brain/plugins/HumanApprovalPlugin.ts`，将原本从 `sessionContext` 获取安全白名单的逻辑改为导入并调用新建立的 `SecurityService` 接口。

<!-- checkpoint: npm run build -->

## 3. 全局配置加载器防污染注入改造

- [x] 3.1 修改 `src/config/loader.ts`，把 `ensureConfigFiles()` 从 `loadConfig()` 开头剥离移出。
- [x] 3.2 改造 `loadConfig`，使其能够显式接受可选的环境变量参数 `env?: Record<string, string | undefined>`。将函数内部所有对 `process.env` 的显式读取替换为对参数 `env` 的读取。
- [x] 3.3 修改主程序启动入口 `src/index.ts`，在启动主流程处显式执行 `ensureConfigFiles()`，确保在正常 CLI 交互中配置自动初始化拷贝。
- [x] 3.4 调整 `test/config/loader.test.ts` 中的单元测试，将原先通过改写全局 `process.env` 并依赖 `beforeEach` 预设 `DEEPSEEK_API_KEY` 的测试，改造为向 `loadConfig()` 直接注入局部 Mock 环境参数，验证物理隔离与无副作用加载。

<!-- checkpoint: npm run test -->
