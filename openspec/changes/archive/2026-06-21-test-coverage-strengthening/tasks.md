## 1. 核心用例层服务单测补强

- [x] 1.1 编写 `test/brain/CompactionService.test.ts` 单元测试：为 driver (`LlmPort`) 构造 Mock Stub（特别是 stub 异步摘要生成 `generateSummaryAsync` 方法），覆盖硬截断 compact、异步压缩触发以及 collectReadToolFilePaths 历史路径提取逻辑，使 `CompactionService` 的 Statement 覆盖率达 70% 以上。
- [x] 1.2 改造并测试 `ContextRepository`：
   - 生产代码改进：为 `ContextRepository` 的构造函数添加可选的 `workspacePath?: string` 参数，替代内部硬编码的 `process.cwd()`。
   - 单测编写：创建 `test/brain/ContextRepository.test.ts`，在 `beforeEach` 中使用 `fs.mkdtempSync` 创建随机隔离目录并传入，覆盖 `saveState` 落盘、`rollback` 回滚回溯等逻辑，消除多线程并发 I/O 竞态，使 `ContextRepository` 的 Statement 覆盖率达 80% 以上。
- [x] 1.3 改造并测试 `ToolDispatcher`：
   - 生产代码改进：为 `ToolDispatcher` 的构造函数添加可选的 `workspacePath?: string` 参数，以替代其内部的文件操作寻路路径。
   - 单测编写：创建 `test/brain/ToolDispatcher.test.ts`，传入临时沙箱路径，Mock filesystem 相关工具，覆盖大输出 offloading（落盘转存）机制及 JIT 工具的加载与调度，使 `ToolDispatcher` 的 Statement 覆盖率达 85% 以上。

<!-- checkpoint: npx vitest run test/brain/CompactionService.test.ts test/brain/ContextRepository.test.ts test/brain/ToolDispatcher.test.ts -->

## 2. 安全与规则管理服务单测补强

- [x] 2.1 改造并测试 `SecurityService`：
   - 生产代码改进：在 `SecurityService` 生产代码中添加供测试专用的 `@internal resetInstance()` 静态方法以清空单例；同时允许在 `getInstance(configPath?)` 中传入可选的白名单保存路径，替代硬编码的 `.agent/allowed_commands.json`。
   - 单测编写：创建 `test/brain/SecurityService.test.ts`，在 `beforeEach` 中使用随机沙箱路径初始化并写入临时白名单，在 `afterEach` 中无条件执行 `SecurityService.resetInstance()` 以防止状态污染。覆盖命令前缀校验、文件放行策略、以及临时读写白名单时效管理分支，使 `SecurityService` 覆盖率达 85% 以上。
- [x] 2.2 编写 `test/brain/RuleManager.test.ts` 单元测试：在测试实例化 `RuleManager` 之前，使用 `vi.spyOn(process, 'cwd')` 重定向返回 `fs.mkdtempSync` 沙箱路径，并在该沙箱内物理写入 Mock 伴生规则文件。重点覆盖 `reloadRules` 对全局和项目伴生规则的重新加载逻辑，使 `RuleManager` 的 Statement 覆盖率达 80% 以上。

<!-- checkpoint: npx vitest run test/brain/SecurityService.test.ts test/brain/RuleManager.test.ts -->

## 3. UI 渲染与门面层单测补强

- [x] 3.1 编写 `test/interface/CliFacade.test.ts` 单元测试：
   - 前置依赖：Mock 构造一个可用的 `SessionManager` 实例，提供必需 of `approvalService.registerApprovalHandler` 和 `BrowserSession.userInterventionHandler` 的 stub 以免抛出未注册异常。
   - UI 拦截：在 `beforeEach` 全局 Mock `process.exit` 防止测试夭折；劫持 `process.stdout.write` 并清除其中的 ANSI 终端转义字符，对流式 `AgentEvent` 事件（thinking、content、error、suspend、complete）的渲染纯文本内容进行断言，在 `afterEach` 恢复 stdout 劫持。使 `CliFacade` 的 Statement 覆盖率达 60% 以上。

<!-- checkpoint: npx vitest run test/interface/CliFacade.test.ts -->

## 4. 整体覆盖率验证

- [x] 4.1 执行全量单元测试与覆盖率收集，验证 `core/usecases` 整体 Statement 覆盖率不低于 80% 且所有单测全部绿灯通过。

<!-- checkpoint: npx vitest run --coverage -->

## 5. 修复代码规范与 Lint 问题

- [x] 5.1 修复测试文件（`ToolDispatcher.test.ts`、`RuleManager.test.ts`、`CliFacade.test.ts`、`loopback.test.ts`）中的 `any` 显式声明，改用具体类型或 `unknown` 以符合 `@typescript-eslint/no-explicit-any`。
- [x] 5.2 修复 `CliFacade.test.ts` 中的正则表达式控制字符，消除 `no-control-regex` 报错。
- [x] 5.3 清理测试文件中与定义但未引用的变量（如 `vi`、`originalWrite`、`name` 等）以符合 `@typescript-eslint/no-unused-vars`。

<!-- checkpoint: npm run lint -->
