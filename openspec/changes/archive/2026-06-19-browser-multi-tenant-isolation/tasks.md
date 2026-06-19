## 1. 会话上下文与工具调度支持租户标识

- [x] 1.1 重构 `src/brain/context.ts` 的 `SessionContext` 类，在其中引入 `tenantId` 属性（默认为 `'default'`)，并提供相应的 Getter 与 Setter 接口。
- [x] 1.2 重构 `src/brain/services/ToolDispatcher.ts`，在分发 Native Tool 调用时，将当前的 `SessionContext` 的 `tenantId`（或 `SessionContext` 实例本身）传递给 `NativeTool.execute` 的第二入参。
- [x] 1.3 确认 `src/brain/session.ts` 等会话调度引擎中关于租户标识的流转链路正确无误。

<!-- checkpoint: npm run build -->

## 2. 浏览器多租户隔离与动态路由底座开发

- [x] 2.1 重构 `src/action/tools/browser/browser-action.ts` 中的 `BrowserSession` 类。将原来的单例静态属性 `context` 和 `page` 重构为基于 `tenantId` 映射的静态 Map 容器（`contextsMap` 与 `pagesMap`）。
- [x] 2.2 重构 `BrowserSession.getPage` 静态方法，使其支持传入 `tenantId`。在新建 Persistent Context 时，动态拼接并装载本地物理隔离路径 `.myagent/browser-session/<tenantId>/`。
- [x] 2.3 在 `BrowserSession` 中实现静态 `closeTenant(tenantId, cleanup: boolean)` 定向释放方法，安全释放该租户占用的页面和上下文，并在 `cleanup` 为 true 时递归删除该租户的物理 Profile 缓存文件夹。同时在全局生命周期中注册对 Node.js 进程意外强退信号（如 `exit`、`SIGINT`、`SIGTERM`）的监听拦截，在退出前强行释放所有 contextsMap 的浏览器进程与临时目录资源。
- [x] 2.4 修改 `src/action/tools/browser/browser-action.ts` 中全部 8 个浏览器原生工具类，在执行 `execute` 阶段路由 `BrowserSession.getPage` 时隐式传入上下文中的租户 ID。

<!-- checkpoint: npm run build -->

## 3. 并发隔离集成测试与校验

- [x] 3.1 编写针对多租户并发隔离的集成测试用例，放置于 `test/action/browser-action-multitenant.test.ts` 中。
- [x] 3.2 模拟租户 `tenant-a` 和 `tenant-b` 在极短时间内并行调起网页导航，验证底层 user-data-dir 分配确实独立，且两个会话实例互不穿透。
- [x] 3.3 验证调用 `BrowserSession.closeTenant(tenantId, true)` 后，特定临时租户的缓存文件夹能够被安全清除；并模拟进程信号意外中断（如发出 SIGINT），测试其在意外强退场景下能否优雅释放僵尸进程和锁。
- [x] 3.4 运行静态规范校验（`npm run lint`）和全量测试（`npm run test`）以确保重构没有破坏既有测试，全部绿灯通过。
- [x] 3.5 修复 `test/action/browser-action-multitenant.test.ts` 中因为移除 eslint-disable-any 注释而暴露的 11 处 `@typescript-eslint/no-explicit-any` 类型校验错误，通过类型收窄与 spyOn 重构实现完全的静态类型安全。

<!-- checkpoint: npm run test -->

