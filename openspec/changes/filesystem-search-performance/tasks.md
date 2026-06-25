## 1. 异步生成器与目录剪枝遍历开发

- [x] 1.1 在 `src/adapters/tools/tools/filesystem/search.ts` 中设计并实现一个基于 `fs.promises.opendir` 的异步流式文件树遍历生成器。
- [x] 1.2 从 `AppConfig` 的 `runtimeLimits` 中动态提取排除目录集合（并在不存在时退避至系统级默认项如 `.git`, `node_modules`, `.venv` ），并在遍历过程中进行预编译正则判定。
- [x] 1.3 实现前置剪枝机制，一旦目录节点被判定属于排除项，直接终止下探，严禁执行 `yield*` 的下层递归。

<!-- checkpoint: npx tsc --noEmit -->

## 2. 自研并发信号量调度与工具接入

- [x] 2.1 在 `src/adapters/tools/tools/filesystem/search.ts` 中手写自研极简的 Promise 信号量限流调度器，利用队列对并发 Promise 进行滑动窗口式的按序排队与唤醒。
- [x] 2.2 接入 `GrepSearchTool` 检索逻辑，将原先同步读取文件的 `readFileSync` 替换为异步读取 `fs.promises.readFile`，且所有读取并发请求必须由自研并发信号量调度器统一包装限流（限制最大并发句柄数为 30 个）。
- [x] 2.3 接入 `GlobSearchTool` 检索逻辑，将其底层同步目录遍历替换为上述异步流式遍历生成器。

<!-- checkpoint: npx tsc --noEmit -->


## 3. 全局测试验证与回归自测

- [x] 3.1 运行单元测试 `test/action/tools.test.ts` 及其它检索相关测试，确保改造后工具有效性未受破坏，外部返回的 JSON 结构与旧版格式绝对兼容。
- [x] 3.2 补充针对性的测试用例，校验异步遍历的目录级剪枝防爆行为、以及高并发句柄读取下的信号量拦截机制是否切实有效。
- [x] 3.3 执行全量 ESLint 代码规范与 TypeScript 编译校验。

<!-- checkpoint: npm run test -->

