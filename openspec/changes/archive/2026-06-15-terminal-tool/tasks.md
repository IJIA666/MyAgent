## 1. 核心执行框架搭建 (Execution Engine)

- [x] 1.1 在 `src/action/native-tools/terminal.ts` 中搭建基础框架，引入 `child_process.spawn` 替代 `execSync`。
- [x] 1.2 实现 `timeoutMs` 和 `noOutputTimeoutMs` 超时控制逻辑。
- [x] 1.3 集成 Windows 特有逻辑：自动注入 `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8` 解决中文乱码。
- [x] 1.4 实现超时强杀逻辑：针对 Windows 平台，封装 `taskkill /PID <pid> /T /F`，带错误降级。
- [x] 1.5 针对 Windows Node 环境的 CVE-2024-27980 安全更新，实现 `npm`/`npx` 等 `.cmd` 命令的底层重定向（转化为 `node.exe npm-cli.js`），以在 `shell: false` 时绕过执行异常。

<!-- checkpoint: npm run build -->

## 2. 安全护栏与日志截断 (Security & Logging)

- [x] 2.1 实现硬编码的正则阻断 `/[\&\|\<\>\^\%\r\n]/`，拦截复合命令符。
- [x] 2.2 实现沙箱隔离检测，校验并锁死传入的 `cwd` 必须在工作区根路径下，否则抛出越权异常。
- [x] 2.3 实现实时标准流监听，并增加在内存中维持头部与尾部 Chunk 的截断逻辑 (Max Bytes Limit)。
- [x] 2.4 实现超大输出日志时，将完整日志流式异步写入 `%TEMP%` 临时日志文件的能力 (Disk Spilling)。

<!-- checkpoint: npm run build -->

## 3. 错误捕获与自动流转 (Buffer, Auto-Background & Registry)

- [x] 3.1 实现命令退避策略：若检测到返回 `exit 1` 并且无实质性错误日志时（模拟 `grep` 等），附加说明提示。
- [x] 3.2 实现针对后台驻留任务的 `200ms` 启动缓冲监控期，失败即报。
- [x] 3.3 实现智能阻塞降级 (Auto-Backgrounding)：超过 15 秒同步卡死则解除等待，自动返回 `Task ID` 并留于后台。
- [x] 3.4 格式化输出增强：将执行的退出码、执行耗时、以及完整日志路径包装为对大模型友好的 `<shell_metadata>` XML 标签附加在末尾。
- [x] 3.5 在 `src/action/tools.ts` 的工具注册表中完整接入新的 Terminal 工具并进行类型挂载。

<!-- checkpoint: npm run build -->

## 4. 安全模式与白名单持久化 (Work Modes & Persistence)

- [x] 4.1 在配置中引入工作模式概念 (Safe, Auto, YOLO) 以及全局状态管理。
- [x] 4.2 实现 `Always Allow` 的回调钩子，将被放行的命令模式以 JSON 格式持久化写入到 `.agent/allowed_commands.json`。
- [x] 4.3 实现“静态前缀提取”算法：在首次拦截命令时，自动提取安全的前缀（必须满足 Root + 纯字母数字 Subcommand，如 `npm run`），直接作为推荐规则提供给用户放行。
- [x] 4.4 在拦截核心引擎前，加入白名单校验拦截器（支持前缀和正则匹配），若命中且处于非 Safe 模式，自动跳过提示交互。

<!-- checkpoint: npm run build && npm run test -->
