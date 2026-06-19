## 新增需求

### 需求: 全局运行控制参数的配置化支持
系统必须（MUST）支持在 `.env` 配置文件或系统环境变量中设定 5 项参数限制，并在启动加载配置时安全解析。这些配置包括：
1. `maxIterations`（大模型最大迭代轮数，环境变量 `AGENT_MAX_ITERATIONS`，默认 `20`）
2. `largeToolOutputLimit`（工具超长返回落盘字节限制，环境变量 `AGENT_LARGE_TOOL_OUTPUT_LIMIT`，默认 `8000`）
3. `readManyFilesLimit`（批量文件读取熔断阈值，环境变量 `AGENT_READ_MANY_FILES_LIMIT`，默认 `50000`）
4. `searchLimit`（文件/文本搜索最大匹配结果条数，环境变量 `AGENT_SEARCH_LIMIT`，默认 `100`）
5. `compactionWatermarkFactor`（Token 占用水位触发自动压缩的比率上限，环境变量 `AGENT_COMPACTION_WATERMARK_FACTOR`，默认 `0.8`）

#### 场景: 从环境变量成功加载并重写配置
- **WHEN** 系统启动且 `.env` 环境变量中设定了 `AGENT_MAX_ITERATIONS=30`，而其他参数未设置时
- **THEN** 全局配置解析后得到的 `AppConfig.runtimeLimits.maxIterations` 必须是数值型 `30`，而其他 4 项参数必须自动应用默认常量（如 `largeToolOutputLimit` 为 `8000`）。

#### 场景: 异常输入时的兜底降级
- **WHEN** 环境变量中配置的参数为非法数字（如 `AGENT_SEARCH_LIMIT=abc`）或空字符串时
- **THEN** 配置加载器必须将其安全地回退为原硬编码常量（如 `searchLimit` 为 `100`）作为降级兜底，保障系统安全初始化而不会崩溃。

### 需求: 跨模块的配置依赖注入与动态消费
系统必须（MUST）在 `SessionContext` 中提供全局 `AppConfig` 的访问接口，从而支持各类内置工具、插件服务等在运行期间动态按需消费。

#### 场景: 文本搜索工具执行时的条数限制消费
- **WHEN** 大模型触发 `grepSearch` 或 `globSearch` 工具执行，调用 Native 工具的 `execute` 方法且系统传入了当前的 `sessionContext` 时
- **THEN** 工具内部必须通过传入的 `sessionContext` 动态读取当前配置的 `searchLimit` 限制，并据此过滤截断返回的匹配文件条数。

#### 场景: 超大工具输出拦截落盘的阈值消费
- **WHEN** 大模型执行完工具，系统在 `ToolDispatcher` 内部拦截该结果时
- **THEN** 工具分发器必须通过关联的 `SessionContext` 动态读取 `largeToolOutputLimit` 限制，对超过该阈值的工具返回结果执行溢出落盘并输出文件路径预览。
