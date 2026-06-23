## 1. 统一日志代理层 DRY 重构与进程监听清理

- [x] 1.1 修改 [logger.ts](file:///d:/Projects/MyAgent/src/utils/logger.ts)，提取通用的内部私有辅助方法 `callRawLogger`，重构包装代理 `logger` 对象的 `debug`, `info`, `warn`, `warning`, `error`, `fatal` 实现为单行调用。
- [x] 1.2 修改 [index.ts](file:///d:/Projects/MyAgent/src/index.ts)，彻底移除无用的空 exit 事件监听 `process.on('exit', () => {})`。

<!-- checkpoint: npm run lint -->

## 2. 向量数据库适配器 process.env 解耦与依赖注入

- [x] 2.1 修改 [LocalVectorDbAdapter.ts](file:///d:/Projects/MyAgent/src/adapters/vectordb/LocalVectorDbAdapter.ts)，重构构造函数，去除直接读取 `process.env.AUTHORIZED_WORKSPACE_DIR`，改为以 `process.cwd()` 为兜底默认物理路径计算基准。
- [x] 2.2 修改 [JsonVectorDbAdapter.ts](file:///d:/Projects/MyAgent/src/adapters/vectordb/JsonVectorDbAdapter.ts)，重构构造函数，去除直接读取 `process.env.AUTHORIZED_WORKSPACE_DIR`，改为以 `process.cwd()` 为兜底默认物理文件路径计算基准。
- [x] 2.3 修改 [index.ts](file:///d:/Projects/MyAgent/src/index.ts)，在实例化 `LocalVectorDbAdapter` 时，显式传递已在入口解析完成的 `appConfig.workspace` 绝对路径拼接的子目录参数。

<!-- checkpoint: npm run test -->

## 3. 全局源码级日志冗余注释批量清理

- [x] 3.1 检索并批量删除 codebase 中散布在所有源文件（主要在 `src/core/usecases/`、`src/adapters/` 等）共计 54 处形如 `// 使用统一日志单例 logger 打印...` 的无意义机械行内注释。

<!-- checkpoint: npm run lint -->
