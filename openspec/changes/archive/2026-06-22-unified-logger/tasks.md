## 1. 基础依赖引入与 Logger 工具类开发

- [x] 1.1 使用 `npm install @logtape/logtape @logtape/file` 或修改 `package.json` 添加依赖，并运行 `npm install` 安装
- [x] 1.2 创建 `src/utils/logger.ts` 并实现全局单例 Logger。实现 `configure` 配置 ConsoleSink 和 RotatingFileSink，配置 `maxSize: 10 * 1024 * 1024`（ 10MB ）、 `maxFiles: 5` ，并对测试环境检测 `process.env.VITEST` 时不配置 sinks 数组以达到静音屏蔽效果
- [x] 1.3 在 `src/index.ts` 最上方执行异步初始化 Logger ；同时挂载 `SIGINT` 和 `SIGTERM` 异步信号，在进程退出前执行异步 `await dispose()` 刷盘操作，而在 `process.on('exit')` 同步回调中仅执行同步重置兜底

<!-- checkpoint: npm run build -->

## 2. Immer Patch 降噪处理与单例 Logger 测试

- [x] 2.1 修改 `src/core/usecases/plugin-runner.ts` 引入 `src/utils/logger.ts` 中的 logger
- [x] 2.2 在 `plugin-runner.ts` 打印 patch 日志前，对 patches 数组执行 Map 压缩，将大于 100 字符的字符串替换为 `"[String: X chars]"`，数组替换为 `"[Array: X items]"`，并使用 `logger.debug` 进行降级输出
- [x] 2.3 编写日志模块的测试用例，覆盖测试静音逻辑、日志文件大小轮转及 patches 截断逻辑，运行测试验证 Logger 的核心功能

<!-- checkpoint: npm run test -->

## 3. 存量 console 统一替换与 ESLint 编译守护

- [x] 3.1 梳理 `src/` 底层 core 业务与 vectordb 驱动等 32 个存量文件，将其中的 `console.log` / `console.error` 等诊断输出统一替换为 `logger.info` / `logger.error` 等，并保留 interface 视图层与入口文件的原生 UI 渲染 console
- [x] 3.2 修改 `eslint.config.js` 的配置规则，对 `src/adapters/input/`、`src/index.ts` 保持 `"no-console": "off"`，对 `src/utils/logger.ts` 豁免 `"n/no-process-env"` 限制，对其他所有核心业务与驱动子目录强制开启 `"no-console": "error"`，在静态编译构建层级进行阻断

<!-- checkpoint: npm run lint -->
<!-- checkpoint: npm run test -->
