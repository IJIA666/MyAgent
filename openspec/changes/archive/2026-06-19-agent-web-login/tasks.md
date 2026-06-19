## 1. 基础依赖与环境检测逻辑

- [x] 1.1 在 package.json 中新增 playwright 依赖包。
- [x] 1.2 执行 npm install 并使用 Playwright 进行常规浏览器系统目录（Chrome/Edge）检测器开发，编写探测 executablePath 的辅助工具类 `browser-detector.ts` 并保存于 `src/action/native-tools/`。
- [x] 1.3 编写 executablePath 检测器的单元测试以验证是否可正确扫出本地系统自带浏览器路径。

<!-- checkpoint: npm run build -->

## 2. 浏览器自动化 Action 工具开发

- [x] 2.1 创建 `src/action/native-tools/browser-action.ts` 并基于 Playwright 开发核心控制 API（集成 executablePath 复用逻辑）。
- [x] 2.2 在 `browser-action.ts` 中实现 CDP 调试直连模式（`connectOverCDP`）与本地持久化 Profile 会话模式（`launchPersistentContext`）。
- [x] 2.3 在 `browser-action.ts` 中开发轻量化 AriaSnapshot 算法，提取可交互 DOM 节点并分配 `@eN` ID 作为快照文本返回。
- [x] 2.4 在 `browser-action.ts` 中映射大模型传入的 `@eN` 指令到具体的 ElementHandle 并执行 Playwright 真实页面操作（click, type, scroll, back, press, screenshot）。
- [x] 2.5 修改 `src/action/toolRegistry.ts` 与 `src/action/virtual-mcp.ts` 注册并挂载 `browser_navigate`、`browser_click`、`browser_type`、`browser_scroll`、`browser_back`、`browser_press` 和 `browser_vision` 等 Native Tools。

<!-- checkpoint: npm run build -->

## 3. 命令行阻塞与人机协作机制开发

- [x] 3.1 在 `src/interface/` 的交互 CLI 和 theme 中，新增对人机风控登录的黄色阻塞高亮提示 UI，并实现异步等待读取回车输入的阻塞函数（**注意在等待结束后立即执行 Readline 实例的 `.close()`，并对 `process.stdin` 执行 `.pause()` 以释放流监听，防止与 CLI 主线程流抢占或导致挂起死锁**）。
- [x] 3.2 在 `src/brain/index.ts` 中的 `SessionManager` 里接入登录拦截与风控的检测，触发上述阻塞干预回调，并在释放阻塞后同步页面 Snapshot 状态以确保事件循环平滑过渡。

<!-- checkpoint: npm run build -->

## 4. 集成测试与规范校验

- [x] 4.1 编写针对浏览器工具直连本地隔离 CDP（9222端口）及本地 Persistent 登录态保存的集成测试脚本，放于 `test/action/browser-action.test.ts`。
- [x] 4.2 运行代码风格与排版校验（ESLint），确保遵守阿里开发规范与 JSDoc 规范。
- [x] 4.3 运行全量 Vitest 集成测试，验证所有场景全部 PASS。

<!-- checkpoint: npm run test -->

## 5. [Amend 修正] 解决构建转译下 evaluate 闭包的 __name is not defined 致命报错

- [x] 5.1 对 `src/action/native-tools/browser-action.ts` 中的 `generateAriaSnapshot` 进行重构，将 `isVisible` 逻辑彻底内联，并把 `allCandidates.forEach` 改写为原生的 `for` 循环，彻底规避因转译器注入 `__name` 元数据在浏览器侧执行导致 ReferenceError 的技术隐患。
- [x] 5.2 重新运行静态规范校验（`npm run lint`）与全量 Vitest 集成测试（`npm run test`），验证修复后系统在各网页上的兼容性与快照功能的正确性。

<!-- checkpoint: npm run test -->

## 6. [调试修正] 规范重构：内置浏览器工具模块重定位到 hexagonal-tools-decoupling 规范目录

- [x] 6.1 在 `src/action/tools/` 下新建 `browser` 目录，将原本 `native-tools` 目录下的 `browser-action.ts` 和 `browser-detector.ts` 移动过去，并物理删除被废弃的 `src/action/native-tools/` 目录。
- [x] 6.2 级联修正 `src/action/virtual-mcp.ts`、`src/brain/session.ts` 以及测试文件的引用路径。
- [x] 6.3 重新进行静态代码规范校验（`npm run lint`）与全量 Vitest 集成测试（`npm run test`）以确保重定位重构没有引起任何编译和功能衰退。

<!-- checkpoint: npm run test -->
