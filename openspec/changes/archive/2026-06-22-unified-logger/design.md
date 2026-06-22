## 背景

当前系统依赖于原生的 `console.log/warn/error` 机制进行所有的诊断调试输出，面临终端交互噪音严重（ 尤其是 Immer patches 会全量打印 System Prompt 大文本 ）以及日志没有持久化、应用退出无法溯源的问题。需要实现一套对控制台友好（ 支持着色与分级降噪 ）、可安全落盘且支持轮转老化的统一日志模块。

## 目标与非目标

**目标:**
- 统一日志接口规范，将系统内部的调试诊断日志与 UI 交互直出进行物理分离。
- 引入零外部深层依赖的现代 TS/ESM 日志库 LogTape。
- 支持诊断日志分级管理（ `DEBUG` 、 `INFO` 、 `WARN` 、 `ERROR` ），终端控制台默认过滤 `DEBUG` 信息。
- 支持日志自动文件落盘（ 写入 `.myagent/run.log` ），具备单文件最大 10MB 、保留最多 5 个备份的日志文件大小自动轮转清理能力。
- 解决 Immer patches 大文本打印对终端造成的严重噪音。
- 支持测试运行（ Vitest ）下的静音保护与进程异常退出时的刷盘防丢失防护。
- 通过 ESLint 构建级别守卫，防止业务层再次无约束引入 `console.log` 等代码。

**非目标:**
- 本次改造不涉及系统内部日志的多链路 APM 云端发送（ 如 OTLP ）。
- 绝不改动或替换 `src/adapters/input/interface/` 目录下及 `src/index.ts` 顶层正常的面向用户的 CLI 交互展示代码（ 如 Clack 的渲染与 banner 输出 ）。

## 架构决策

1. **核心日志组件选择（ 方案 D：LogTape ）**：
   - *决策原因*：虽然 Winston 和 Pino 是老牌日志库，但 Winston 的依赖庞大（ 17+ 依赖 ），对轻量级 CLI Agent 来说过于臃肿；Pino 则存在与原生 TSX/ESM 运行环境的兼容摩擦（ 需要 `.default` 处理 ）。自研极简 Logger 虽无依赖，但若实现多 sink 配置、安全的异步文件追加写和日志轮转，会耗费大量非核心编码并容易在轮转文件锁竞争时发生 Bug。而 LogTape 是一个零外部深层依赖、专为 ESM 和 TypeScript 打造的轻量库，其 `@logtape/file` 包自带经过工业验证的 `getRotatingFileSink`，因此是本项目的最佳选型。

2. **进程退出刷盘保护策略**：
   - *决策原因*：由于 LogTape 的日志追加落盘包含异步缓存写入机制，为了防止因应用被意外强制终止（ 如用户按下 Ctrl+C 触发 `SIGINT` 或系统发送 `SIGTERM` 信号 ）时数据丢失，必须捕获异步退出信号并在完全退出前进行强制刷盘。
   - *具体实现*：挂载 `process.on('SIGINT')` 和 `process.on('SIGTERM')` 异步信号监听，在其中执行 `await dispose()`，确认刷盘完毕后再显式调用 `process.exit(0)`。对于同步的 `process.on('exit')` 回调，由于 Node.js 限制其不支持任何异步 Promise 等待，因此仅作为同步状态清理的极简重置，不进行任何 dispose 等待。

3. **测试环境极简静音控制**：
   - *具体实现*：在 `src/utils/logger.ts` 中，检测到 `process.env.VITEST` 且未开启 `process.env.MYAGENT_TEST_LOG` 时，自动在 LogTape 的 `configure` 配置中将 `sinks` 数组或 `loggers` 列表传入空值，从而彻底物理屏蔽所有文件与控制台输出，避开 LogTape 缺乏原生 `silent` 级别的问题。

4. **Immer 补丁摘要 Map 压缩**：
   - *具体实现*：在 `src/core/usecases/plugin-runner.ts` 打印 patch 日志前，对 `patches: Patch[]` 进行扁平压缩。针对 `patch.value` 类型为字符串且字符长度超过 100 字符的情形，替换为 `"[String: X chars]"`，数组类型则替换为 `"[Array: X items]"`，避免由于 system prompt 重复打印撑爆日志文件；同时将原有的 `console.log` 替换为 `logger.debug` 进行降级处理。

5. **ESLint 静态规则守护**：
   - *具体实现*：修改 `eslint.config.js` 。将原本宽松的 `"no-console": "off"` 升级为精细化控制：除 `src/adapters/input/interface/` （ 命令行视图层 ）、 `src/index.ts` （ 启动入口 ）以及 `src/utils/logger.ts` （ 日志实现文件 ）外，对所有其他目录全部开启 `"no-console": "error"` 限制。此外，由于项目配置了 `"n/no-process-env": "error"`，我们必须在此配置中为 `src/utils/logger.ts` 单独添加 `"n/no-process-env": "off"` 的例外豁免，允许其读取 `process.env` 环境变量。

## 风险与权衡

- **[ 风险点 ]**：存量 `console.*` 替换点较多（ 约 32 个文件，100 处左右 ），手动全量修改容易在参数传入或类型转换时产生细微疏漏。
  - *缓解策略*：采取分批逐步替换。先替换 `core` 核心业务部分，再替换其他外围驱动部分，每批修改完毕后运行 `npm run test` 确保业务用例无任何回归。
- **[ 风险点 ]**：LogTape 初始化和销毁（ `configure` / `dispose` ）在 API 上属于异步 Promise 操作，若在同步流式应用生命周期中调用时机不对，可能引起未捕获的 Promise Rejection。
  - *缓解策略*：在 `src/index.ts` 顶层入口的最上方使用 `await` 保证在 CLI 引擎加载前 Logger 配置彻底就绪；在退出信号捕获中，仅在异步的 `SIGINT` 和 `SIGTERM` 处理器中 `await dispose()` 并随后调用 `process.exit(0)`，在同步 `exit` 监听中绝不使用 `await`。
