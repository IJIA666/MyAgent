# 探索主题: 统一日志模块（Logger）

## 1. 问题定义

当前所有内部诊断信息（Plugin Trace、向量库重建、SessionManager 状态等）均直接调用 `console.log/warn/error`，导致两个问题：

1. **控制台噪音严重**：`[Plugin Trace] Hook BeforeModel context modified:` 每轮对话触发一次，将几千字的 System Prompt Patch 以原始 JSON 打印到终端，严重干扰用户体验。
2. **日志无持久化**：上述输出全部只打到 stdout/stderr，不会流入 `AgentTracer` 等任何持久化机制，运行时报错或关键事件在会话结束后无从溯源。

## 2. 关键发现与调研结果

- **代码库现状**：经 `grep` 检索，`src/` 目录下共在 32 个文件中包含 `console.` 调用，主要诊断日志调用量估算在 80-120 处之间（原估算 180+ 偏高）。其中 `plugin-runner.ts:181` 是最大噪音源，将完整 Immer Patch（含 System Prompt 全文）格式化后直接打印。
- **核实与洞察**：
  - Pino（高性能 JSON Logger）和 Winston（多 transport Logger）均为成熟方案，但 ESM 兼容存在轻微配置摩擦（Pino 需要 `.default` 处理），且 Winston 依赖数过多（17+），对 CLI Agent 工具过重。
  - **LogTape** 是一个 2025/2026 年兴起的 **零外部依赖**、原生 ESM、TypeScript 优先的轻量日志库。它支持 ConsoleSink 与来自 `@logtape/file` 的 FileSink / RotatingFileSink，能够开箱即用地支持日志轮转。
  - 自研极简 Logger（约 150-200 行）可覆盖基础输出和追加落盘，但如果需要处理安全的异步写入和日志轮转，会产生较多非核心的工程性代码。

### 竞品调研：Claude Code 日志机制

- **缓冲写入机制**：使用 `BufferedWriter` 对文件写入进行缓冲合并，默认 `flushIntervalMs: 1000` 或缓冲区达到 50-100 行时进行一次性写入，有效减少磁盘 I/O 阻碍。

- **延迟加载解耦**：将轻量错误接口 (`log.ts`) 与重量级文件写入实现 (`errorLogSink.ts`) 剥离。在应用启动阶段未完成初始化前，通过内存队列 `errorQueue` 缓存所有报错事件，待 Sink 初始化完毕后一次性排出，防范模块循环引用。

- **分级过滤与控制**：通过 `CLAUDE_CODE_DEBUG_LOG_LEVEL` 环境变量设置最低调试等级（如 `debug`, `verbose` 等），并在每条日志写入前通过 `LEVEL_ORDER` 校验，实现极其精准的性能控制与噪音声波抑制。

- **命令行参数绑定**：通过检测 `--debug` 或 `--debug-file` 命令行参数动态激活调试模式，支持通过 `--debug-to-stderr` 参数直接将调试输出重定向至 `stderr` 以供实时观测。

- **实时软链指向**：自动在日志目录下创建指向最新会话日志文件的符号链接（`latest` 软链），方便开发者通过 `tail -f ~/.claude/debug/latest` 等命令持续观测，无需每次重新寻找会话 ID。

- **清理与防丢保护**：集成全局清理机制 `registerCleanup` ，在进程退出或主动回收时执行 `dispose` ，强制刷盘（`flush`）所有缓冲区内的残存数据，确保关键报错和轨迹在应用非正常死亡时不丢失。

- **隔离区分设计**：通过 `USER_TYPE === 'ant'` 判定实现内部员工与大众用户的日志收集边界控制，大众用户主要过滤高频调试输出，避免隐私泄露和不必要的日志文件暴涨。

### 竞品调研：Hermes Agent 日志机制

- **分流路由架构**：通过定义多个日志输出文件，将 `agent.log`（ catch-all ）、`errors.log`（ 仅限 WARNING+ ）与组件相关的 `gateway.log` / `gui.log` 进行隔离分流，支持精细化的错误诊断与排查。

- **会话上下文注入**：利用线程局部变量（ `threading.local` ）和全局 `LogRecord` 工厂，为多线程下特定会话的所有相关日志自动注入 `[session_id]` 前缀，实现低成本且无侵入的会话级日志关联分析。

- **脱敏格式化器**：在日志的 formatter 层包装 `RedactingFormatter` ，自动扫描并拦截可能写入磁盘的 API 密钥或敏感凭据，防止日志内容泄露。

- **防外部旋转机制**：继承并魔改 Python 的 `RotatingFileHandler` 句柄，在写入前对比当前打开的 inode 与文件路径所指 inode ，若因外部旋转（如 `logrotate` 或手动重命名）导致不一致时，自动执行 `reopen` 规避日志静默流失。

- **静默白名单过滤**：内置 `_NOISY_LOGGERS` 列表，强制对 noisy 的第三方依赖库（如 `openai` 、 `httpx` 、 `websockets` ）的日志等级设置为 `WARNING`，防范第三方信息刷屏干扰诊断。

- **非崩溃异常隔离**：针对 Windows legacy 控制台对 Unicode 字符渲染可能崩溃的问题，实现 `_safe_stderr` 过滤器，在出现无法编码字符时执行 fallback 降级替换为 `?`，确保日志写盘动作本身不影响主业务进程。

### 竞品调研：OpenClaw 日志机制

- **生态适配器包装**：针对第三方库强依赖 `pino` 日志接口的现状，实现 `toPinoLikeLogger` 兼容转换器，零依赖封装底层的 `tslog` 接口，解决库依赖的生态摩擦。

- **静音测试执行**：智能探测 `VITEST` 单元测试运行环境，默认将日志级别降为 `silent` ，防止高频单元测试导致磁盘被无用日志占满，支持配置 `OPENCLAW_TEST_FILE_LOG=1` 变量强制按需开启。

- **子系统动态路由**：支持 `subsystemPrefixRe` 正则判定，在文本前缀匹配时自动将日志消息移交给指定的 subsystemLogger 进行归类输出，实现模块与子系统日志边界分离。

- **纯净落盘设计**：控制台使用彩色主题，而落盘文件使用干净的 `JSON.stringify` 结构化纯文本，避免将 ANSI 颜色控制字符写入日志文件，提升自动化分析性能。

- **日期滚动与老化**：默认按 `openclaw-YYYY-MM-DD.log` 日期切分文件，并在换天切换时自动触发 `pruneOldRollingLogs` 执行 `rmSync` 清理 24 小时以上的老旧日志，实现无外部依赖的物理磁盘空间自律。

- **监控链路打通**：自动关联当前上下文中的 `traceId` / `spanId` 等 OpenTelemetry 追踪属性，并通过 `emitDiagnosticEvent` 向 APM 体系进行主动分发，使日志具备全链路追溯性。

### 竞品调研：OpenCode 日志机制

- **函数式管道集装**：借助 `Effect TS` 声明式 `Layer` 切面机制，在应用底层将本地文件日志、 `stderr` 打印与云端 `OTLP` 日志进行一站式流式集成，具备高扩展性的数据拓扑结构。

- **Logfmt 结构化行**：自定义的日志 `formatter` 将每行信息转换为带有 `timestamp` 、 `level` 、 `run` 等核心元数据的 `key=value` 键值对字符串，极大降低主流数据采集器的日志解析开销。

- **安全防御展开**：实现带有 `WeakSet` ( 循环探测 `seen` )的 `flatten` 扁平化对象解析机制，在遇到循环引用的复杂对象展开时，能够截断为 `[prefix, "[Circular]"]` ，防范序列化无限递归引发进程溢出崩溃。

- **空闲 CPU 性能调优**：通过合理限制 `batchWindow` 批处理落盘积攒窗口的大小（ 避免设置为 0 ），极大降低由于无间隔刷盘文件句柄轮询所引起的 CPU 空转开销，保障 CLI 工具的运行时轻量。

- **环境变量实时开关**：引入 `OPENCODE_PRINT_LOGS` 与 `OPENCODE_LOG_LEVEL` 等配置，支持运行时动态开启控制台同步输出，并能够在系统内极简进行各级别过滤的切换。

- **链路Span打通**：在 `formatter` 中把 `spans` 与 `annotations` 属性进行一并展开与对齐，令日志天然支持分布式调用链条，实现真正的立体化可观测性追踪。

## 3. 方案对比与推荐方向

| 评估维度 | 方案 A：Pino | 方案 B：Winston | 方案 C：自研极简 Logger | 方案 D：LogTape |
| :--- | :--- | :--- | :--- | :--- |
| 性能 | 极高，异步 I/O ✓ | 中等 △ | 取决于实现 | 高 ✓ |
| ESM 兼容 | 有坑，需 `.default` 处理 △ | 良好 ✓ | 无依赖，天然兼容 ✓ | 原生 ESM 设计 ✓ |
| 控制台格式化 | 需安装 `pino-pretty` △ | 内置 ✓ | 完全可控 ✓ | 内置 ConsoleSink ✓ |
| 文件落盘 | transport 支持 ✓ | 内置 transport ✓ | 自行实现 appendFile | 内置 FileSink/RotatingFileSink ✓ |
| 日志轮转控制 | 支持 ✓ | 支持 ✓ | 需自行编码实现（复杂） ✗ | 内置支持轮转（开箱即用） ✓ |
| 依赖开销 | 偏重，适合 API 服务 ✗ | 偏重，依赖较多 ✗ | 零依赖 ✓ | 仅引入 core 和 file 两个轻量包 ✓ |

**推荐路径**：优先推荐 **方案 D（LogTape）**，若需绝对零额外依赖则退守至 **方案 C（自研极简 Logger）**：
- **方案 D（推荐）**：引入 `@logtape/logtape` 和 `@logtape/file`，在 `src/utils/logger.ts` 中配置。使用 `getRotatingFileSink(".myagent/run.log", { maxSize: 10 * 1024 * 1024, maxFiles: 5 })`，限制日志膨胀并避免并发文件操作隐患。
- **方案 C（备选）**：自研极简 Logger 单例。为避开复杂的轮转编码，采用**启动时清空覆盖上一次日志**的简化策略。

`[Plugin Trace]` 均降级为 `DEBUG` 级别。通过环境变量 `LOG_LEVEL`（默认 `INFO`）控制终端输出，而文件 sink 始终全量记录（含 `DEBUG`）。

## 4. 约束、风险与未知项

- **UI 输出与诊断日志的边界划分**：
  - *UI 直出*：`index.ts`、`src/adapters/input/interface/` 下的 CLI 交互（Clack、banner、帮助信息展示等）属于 UI 展现，**不应当**被日志模块替换，应继续允许使用原生 `console.log`。
  - *诊断日志*：除 CLI 展现代码外，其它底层的 `core`、`adapters` 等逻辑产生的状态日志必须走 Logger 统一打到文件。
- **Patch 摘要策略**：
  - 在 logger 记录 `[Plugin Trace]` 前，对 Immer patches 数组进行 Map 压缩：如果 `patch.value` 为字符串且长度超过 100 字符，替换为 `"[String: X chars]"`；如果为数组，替换为 `"[Array: X items]"`，避免大段 system prompt 拖慢写入并挤爆日志。
- **日志轮转**：自研方案需限制在启动时清空或实现极简的轮转；LogTape 方案则配置 `maxSize`。
- **进程销毁刷盘保护**：由于 LogTape 包含异步日志写入缓存，必须在进程生命周期终点（ 如 `process.on('exit')` 、 `SIGINT` 、 `SIGTERM` 信号监听中 ）主动调用 `await dispose()` 接口强制刷盘，确保在进程非正常退出时最后的轨迹日志不丢失。
- **测试环境降级静音**：智能捕获 `process.env.VITEST` 环境变量，如果判定在单元测试环境执行，默认将日志等级降级为 `silent` ，防止高频跑单元测试时因频繁的磁盘读写和文本输出干扰终端。
- **存量替换与守卫机制**：
  - 需按目录分批替换（如先 `core`，后其它驱动层）。
  - 替换完成后，将 `eslint.config.js` 中的 `"no-console": "off"` 修改为规则配置，除 CLI 相关目录（如 `src/adapters/input/`、`src/index.ts` 以及 Logger 本身）外，其余代码文件强制开启 `"no-console": "error"`，在编译构建阶段物理拦截。

## 5. 否决方案

- **Pino**：ESM 下 `.default` 的处理有隐患，且 `pino-pretty` 需额外安装，引入成本不划算。
- **Winston**：功能过重，依赖项多，对一个 CLI Agent 来说是杀鸡用牛刀。
