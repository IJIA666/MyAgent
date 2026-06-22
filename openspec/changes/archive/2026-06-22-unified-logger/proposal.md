## 改造原因

当前智能体系统在运行期间的所有内部诊断信息（如 Plugin Trace 插件追踪、向量数据库重建、SessionManager 会话状态记录等）均零散且直接调用原生的 `console.log` 、 `console.warn` 或 `console.error`。这导致了两个关键性的设计缺陷：
1. 控制台信息噪音极高。例如 `plugin-runner.ts` 会将每一轮 Immer 生成的 Patch 补丁信息（包含数千字的 System Prompt ）以全量 JSON 格式打印，严重干扰终端用户进行 CLI 会话的体验。
2. 日志缺乏持久化与可追溯性。所有的诊断数据只输出至 stdout/stderr，应用一旦退出或会话结束，运行时的异常报错或关键生命周期记录便无从追溯。

因此，现在急需引入一个面向现代 TypeScript 和 ESM 生态的高效、零深层依赖的日志模块，规范所有的诊断日志输出逻辑，降低控制台冗余噪音，打通日志文件落盘、滚动轮转与退出刷盘的安全屏障。

## 变更内容

本次改造的主要改动内容如下：
1. 引入零外部深层依赖的现代 ESM 日志框架 LogTape（及其文件写入支持库），在 `src/utils/logger.ts` 中完成全局 Logger 初始化与配置。
2. 开启控制台彩色输出 ConsoleSink 和文件落盘写入 RotatingFileSink 机制，默认将全量日志（含 `DEBUG` 级）保存至 `.myagent/run.log` ，限制单日志大小上限为 10MB 并配置最多保留 5 个历史备份文件。
3. 针对 `[Plugin Trace]` 打印的大文本补丁信息进行 Map 摘要压缩（对超过 100 字符的字符串和数组进行截断摘要记录），并将其降级为 `DEBUG` 日志级别，在终端控制表中默认隐藏。
4. 全面梳理并重构存量 `console.*` 诊断调用（预计 80-120 处，涵盖 core、adapters、config 等底层业务与驱动目录），对于直接展示给用户的 UI 界面打印（如 `src/adapters/input/interface/` 和 `index.ts` 里的 banner 渲染）予以保留，划清 UI 输出与诊断日志的边界。
5. 实施单元测试环境（Vitest）静音策略，在测试运行期间日志输出默认变更为不配置 sinks 数组以达到屏蔽效果；同时，在进程异步退出信号（ `SIGINT` 、 `SIGTERM` ）处理器中挂载 `await dispose()` 刷盘操作，确保应用被中断时最后的轨迹完整。
6. 修改 `eslint.config.js` ESLint 配置，为除 CLI 交互和日志实现模块外的所有核心业务与驱动目录开启 `"no-console": "error"` 守护规则，在编译构建层级进行物理拦截与阻断。

## 业务能力

### 新增业务能力

- `unified-logger`: 集中统一的智能体运行诊断日志管理系统，提供分级拦截、文件安全异步落盘、最大 10MB 自动大小轮转、敏感数据摘要截断、单元测试静音以及进程异常退出强制刷盘销毁的安全保障。

### 修改业务能力

无。

## 影响范围

1. **依赖库**：在 `dependencies` 中新增 `@logtape/logtape` 与 `@logtape/file`。
2. **构建守卫**：修改 `eslint.config.js` ，强化 `"no-console"` 静态扫描规则。
3. **存量逻辑**：对 `src/` 下除了输入接口层 `src/adapters/input/` 与启动入口 `index.ts` 之外的约 32 个核心文件（如 `plugin-runner.ts` 、 `session.ts` 、 `LocalVectorDbAdapter.ts` 等）的 `console.` 调试调用进行全量 Logger 替换。
