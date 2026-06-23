## 改造原因

本次变更致力于解决系统在第一阶段 unified-logger 引入及后续 ESLint 升级后遗留的局部重构不彻底与冗余代码问题：
1. **冗余机械注释噪音**：首轮重构中，替换 console 为 logger 时在 12 个源文件中引入了 54 处形式相同的 `// 使用统一日志单例 logger 打印...` 机械注释。这些注释仅重复代码行为（what），不解释背后原因（why），为开发维护带来了冗余噪音。
2. **Logger 包装代理样板代码过多**：`src/utils/logger.ts` 中 debug, info, warn, warning, error, fatal 6 个方法的日志输出代码均包含重复的三分支对象/Error 类型判断逻辑，存在明显的代码冗余，需进行 DRY 重构。
3. **无用的同步退出监听**：`src/index.ts` 注册了空的回调监听 `process.on('exit', () => {})`。而在进程异步退出（SIGINT/SIGTERM）阶段已有专门的异步 `disposeLogger()` 机制。Node.js 原生 `exit` 事件不支持异步阻塞，空回调对生命周期无任何作用，属冗余代码。
4. **VectorDb 适配器环境变量隐式读取**：`LocalVectorDbAdapter` 和 `JsonVectorDbAdapter` 直接利用 `process.env.AUTHORIZED_WORKSPACE_DIR` 进行隐式路径计算，背离了项目“核心业务与存储层全面解耦全局 process.env 并贯穿依赖注入”的设计原则。

## 变更内容

1. **全面清理冗余注释**：利用批量搜索替换，拔除 12 个源文件（涉及 session、RuleManager、CompactionService 等）中遗留的 54 处 `// 使用统一日志单例 logger 打印...` 机械式行内注释。
2. **DRY 重构 Logger 代理层**：在 `src/utils/logger.ts` 中提取私有通用日志调用适配器 `callRawLogger`，使 6 个级别方法实现合并为单行调用。
3. **移除空 exit 监听器**：删除 `src/index.ts` 中第 88-89 行的空 `process.on('exit')` 回调。
4. **VectorDb 路径依赖注入**：
   - 重构 `LocalVectorDbAdapter` 和 `JsonVectorDbAdapter` 的构造函数，去除直接读取 `process.env.AUTHORIZED_WORKSPACE_DIR` 的机制，降级为以 `process.cwd()` 为默认路径兜底。
   - 在 `src/index.ts` 主入口进行实例化时，由调用方显式拼接并传入 `appConfig.workspace` 绝对路径下的子目录，打通依赖注入。

## 业务能力

### 新增业务能力

### 修改业务能力
- `unified-logger`: 进程非正常退出时移除空同步 exit 事件监听。
- `vector-db-integration`: 向量数据库初始化时引入路径依赖注入并消除全局环境变量直读。

## 影响范围

- **受影响的文件**：
  - `src/utils/logger.ts`
  - `src/index.ts`
  - `src/adapters/vectordb/LocalVectorDbAdapter.ts`
  - `src/adapters/vectordb/JsonVectorDbAdapter.ts`
  - 散布有日志机械注释的 12+ 个源文件（主要在 `src/core/usecases/` 与 `src/adapters/`）。
- **向后兼容性**：不涉及破坏性 API 协议或对外的破坏性变更。`JsonVectorDbAdapter` 在单测中已显示传入了 `tempDbPath` 参数，该行为不被破坏。
