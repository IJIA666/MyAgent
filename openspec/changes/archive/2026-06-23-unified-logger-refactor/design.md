## 背景

在项目的持续演进中，目前遗留了部分与日志和存储初始化相关的低内聚、冗余及不合规的代码细节，主要体现在以下几个方面：
- **Logger 代理层重复逻辑**：`src/utils/logger.ts` 中对外暴露的日志方法（debug/info/warn/warning/error/fatal）直接复制了相同的三分支参数及 Error 类型判断代码，导致模块非常冗长。
- **行内无意义注释泛滥**：第一轮 unified-logger 引入时遗留了 54 处机械式 `// 使用统一日志单例 logger 打印...` 注释，徒增噪音。
- **无用的 Exit 进程事件注册**：`src/index.ts` 注册了空的回调，无法为异步刷盘带来实质作用，需清理。
- **物理存储适配器隐式环境耦合**：`LocalVectorDbAdapter` 与 `JsonVectorDbAdapter` 在构造函数中私自读取全局环境变量获取工作区，破坏了依赖注入设计，降低了多租户沙箱的物理隔离安全性。

## 目标与非目标

**目标:**
- **DRY 重构 Logger**：在包装层提取通用适配私有函数，使包装代理方法合并为单行调用。
- **拔除机械注释**：无遗漏删除 54 处机械式 logger 日志行内注释，降低源码噪音。
- **移除 Exit 空回调**：清除 `src/index.ts` 中无用的 `process.on('exit')` 监听。
- **向量库适配器解耦**：彻底清除 VectorDb 两个适配器内的 `process.env.AUTHORIZED_WORKSPACE_DIR` 读取，在入口 `index.ts` 中实例化时显式传入基于 `appConfig.workspace` 绝对路径拼接的子目录路径。

**非目标:**
- 不重构 LogTape 的底层 Sink 配置或日志系统本身的日志级别策略。
- 不引入三方 AOP 库或装饰器拦截，保持简单的 TS 包装结构。
- 不处理 `OpenAiEmbeddingAdapter` 里的 `AGENT_EMBEDDING_*` 环境变量（该部分涉及 loader 及 AppConfig 定义的扩展，作为以后的独立变更处理）。

## 架构决策

- **决策 1：提炼公共适配器辅助函数 `callRawLogger`**
  - *动机*：消灭 6 个日志代理方法的样板代码。
  - *具体实现*：
    ```typescript
    function callRawLogger(
      method: (msg: string, props?: Record<string, unknown>) => void,
      message: string,
      propertiesOrError?: unknown
    ): void {
      if (propertiesOrError instanceof Error) {
        method(message, { error: propertiesOrError.message, stack: propertiesOrError.stack });
      } else if (propertiesOrError && typeof propertiesOrError === "object") {
        method(message, propertiesOrError as Record<string, unknown>);
      } else {
        method(message);
      }
    }
    ```
  - *优点*：使每个代理方法的代码量从 10 行缩减为 1 行（如 `debug(msg, arg) { callRawLogger(rawLogger.debug.bind(rawLogger), msg, arg); }`）。

- **决策 2：VectorDb 路径显式参数化与依赖注入**
  - *动机*：避免适配器隐式读取全局环境变量，支持沙箱目录传递。
  - *具体实现*：
    - `LocalVectorDbAdapter` 和 `JsonVectorDbAdapter` 的构造函数均支持接受路径参数（非必填）。若不传入，默认以 `process.cwd()` 为基准计算默认路径，移除对 `process.env.AUTHORIZED_WORKSPACE_DIR` 的直接耦合。
    - 在应用启动入口 `src/index.ts` 实例化向量库适配器时，显式传递已解析并注入好的物理隔离工作区路径：
      ```typescript
      const vectorDbAdapter = new LocalVectorDbAdapter(
        path.resolve(appConfig.workspace, '.agent/lancedb'),
        path.resolve(appConfig.workspace, '.agent/vectordb.json')
      );
      ```

## 风险与权衡

- **风险 1：批量删除注释时造成意外的代码损坏或误伤**
  - *缓解策略*：使用具体的全文检索字符串逐处精准替换（不进行大规模正则通配），在修改完成后强制运行 `npm run lint` 和 `npm run test` 以校验静态结构与运行时正确性。
- **风险 2：JsonVectorDbAdapter 在测试中未指定路径时的行为退化**
  - *缓解策略*：通过分析 `JsonVectorDbAdapter.test.ts` 源码，确认单元测试中在实例化时均已经显式传入了 `tempDbPath`。若发生独立实例化或外部调用且未传参时，默认路径退化以 `process.cwd()` 目录拼接，该行为符合通用设计且足够安全。
