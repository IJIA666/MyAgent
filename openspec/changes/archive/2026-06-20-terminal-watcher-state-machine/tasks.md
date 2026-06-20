## 1. 终端进程状态机与原子完成通知重构

- [x] 1.1 在 `src/action/tools/system/` 目录下定义任务状态机类型 `TerminalTaskStatus`（PENDING, RUNNING, STALLED, COMPLETED, FAILED, KILLED）。
- [x] 1.2 重构 `src/action/tools/system/terminal-engine.ts` 中的 `activeTasks` 状态定义，增加原子性的 `transitionTaskState` 状态修改入口。
- [x] 1.3 引入对进程的 30 分钟无条件绝对超时门禁，一旦触发则强制将任务状态由 RUNNING 流转为 FAILED 终态并强杀子进程树，防范 vim/less 等 TUI 程序交互卡死。
- [x] 1.4 实现进程退出的单向原子清算，设置 `notified = true`，注销全部关联定时器，并向智能体和用户发送唯一的终态完成 XML 通知，避免事件并发冲突。

<!-- checkpoint: npm run build -->

## 2. 带有频控与熔断保护的 Watcher 唤醒机制

- [x] 2.1 升级 `runCommandEngine` 的入参，允许模型指定 `watch_patterns` 触发词。
- [x] 2.2 在终端输出流监听中增加行级匹配检测，在冷却时间（15 秒）限制内发出 `watch_match` 通知。
- [x] 2.3 增加 Per-Session 计数器。当在冷却时间内高频触发超过限值时，自动触发断路器熔断，永久注销该任务的行匹配机制，并将其降级为 `notify_on_complete` 进程退出通知。

<!-- checkpoint: npm run test -->

## 3. GBK解码适配与 ANSI-Strip Stall Watchdog 卡死检测

- [x] 3.1 在 `package.json` 中引入 `iconv-lite` 作为第三方转译依赖，并执行 npm install 安装。
- [x] 3.2 编写 `chcp` 探测模块。在 Windows 平台初始化时前置获取当前 activity 代码页。如果识别为 936（GBK）等非 UTF8 编码，则使用 `iconv-lite` 对读取的尾部 Buffer 块执行 GBK 解码，防止乱码导致匹配失效。
- [x] 3.3 在 `terminal-engine.ts` 中编写 `stripAnsi` 清洗逻辑，用于剔除字符串中的所有 ANSI 转义和终端控制序列。
- [x] 3.4 挂载 5 秒周期的 `stat` 文件监控。若大小连续 30 秒无增长，提取文件尾部 1024 字节，转码并 `stripAnsi` 后，用中英文 looksLikePrompt 正则进行卡死匹配。匹配成功时强杀进程并抛出 Stall 中断。

<!-- checkpoint: npm run test -->

## 4. 循环缓冲区优化与嵌套过滤降级

- [x] 4.1 实现固定最大大小（共 100KB，头 50KB/尾 50KB 缓冲）的内存**循环缓冲区 (Ring Buffer) 或固定大小的双端队列 (Deque)**，禁止在 `data` 事件中频繁使用 `Buffer.concat().slice()` 拷贝操作，消除 V8 大内存引用泄漏和 GC 频繁碎片。
- [x] 4.2 重写 `src/action/tools/system/terminal-guard.ts`，实现 `stripLeadingEnvAssignments` 剔除前导环境变量。
- [x] 4.3 递归解密嵌套外壳（`env`、`sudo`、`exec`、`sh -c`、`bash -c`），剥离真实二进制；废弃前缀强行阻断，仅对敏感词注入 `Advisory Warning` 元数据；由 `realpath` 展开限制跨盘防沙箱穿透。

<!-- checkpoint: npm run test -->

## 5. 代码质检与规范修复 (Lint & Typings)

- [x] 5.1 修复 `src/action/tools/system/terminal-engine.ts` 中正则控制字符 `no-control-regex` 报错，使用 `new RegExp` 构建以规避控制字符警告；移除无用 `err` 变量（将 `catch (err)` 简化为 `catch`）。
- [x] 5.2 修复 `src/action/tools/system/terminal-guard.ts` 中多处不必要的正则转义字符（`\'` 与 `\"` 改为 `'` 与 `"`）；将未 reassigned 的 `cleanPart` 改为 `const` 声明以通过首选常量 prefer-const 检查。
- [x] 5.3 修复 `src/action/tools/system/terminal-engine.ts` 中 `Buffer` 与 `Uint8Array` 的 TS 编译类型冲突错误（`readSync` 第二参数类型转换，以及将 `headChunks`/`tailChunks` 类型声明改为 `Uint8Array[]`）。
- [x] 5.4 优化头部预览 Buffer 释放，实现当 `headBytes >= 50KB` 时立即 concat 解码并置空 chunks 队列以提前物理释放内存引用。
- [x] 5.5 移除 `TaskInfo` 及整个 engine 中无意义的 `notified` 标志死代码。
- [x] 5.6 优化 Stall Watchdog 大小停滞看守器的 `noGrowthSeconds` 重置机制。在 looksLikePrompt 未命中时重置为 25（减去 5s 周期），形成滑动周期检测，消除 30s 盲窗。
- [x] 5.7 在 `terminal.ts` 的 `ExecuteCommandTool.execute` 调用中，传入 `onNotification` 连通事件通知总线契约。

<!-- checkpoint: npm run lint -->
