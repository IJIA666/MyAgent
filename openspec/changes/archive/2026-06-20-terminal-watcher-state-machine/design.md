## 背景

目前 `MyAgent` 在执行终端任务时，底层依靠 `src/action/tools/system/terminal-engine.ts` 中的 `runCommandEngine` 进行执行和生命周期控制。该模块支持 15 秒自动转后台及 taskkill 进程树强杀，但面临两大核心技术瓶颈：
1. **单线同步阻塞与轮询开销**：任务在后台长跑时，大模型必须靠间歇性轮询 status 来获取进展，浪费 Token 且响应不及时。
2. **后台交互卡死**：由于不支持检测日志中出现的键盘交互等待（如 `[y/n]`），进程极易在后台死锁挂起，且导致任务失联。
3. **竞态条件与上下文风暴**：实时日志特征匹配、进程卡死检测与操作系统级的进程退出三个异步信号如果并发触发，易导致状态冲突与消息重复发送。

## 目标与非目标

**目标:**
1. **原子有限状态机 (FSM)**：在终端引擎中引入原子锁 FSM 状态管理，保证任务状态（PENDING -> RUNNING -> STALLED / COMPLETED / FAILED / KILLED）单向清算，杜绝重复通知。
2. **Watcher 日志唤醒与频控**：允许设置 `watch_patterns` 触发词，一旦日志输出出现关键字符即刻提前唤醒，并配置 Per-Session Rate Limit 冷却期防范日志刷屏导致的 Token 风暴。
3. **Ansi-Strip 与 I18N 卡死看守**：建立 Stall Watchdog。在 30 秒文件大小不增长且 tail text 经过 `strip-ansi` 纯净化后命中中英文交互确认正则时，原子化强杀进程并发出卡死警报。
4. **日志 Spilling 物理分流**：保留完整日志重定向落盘，内存仅截取头尾共 100KB Preview 返回模型。
5. **硬核底层健壮性**：引入 `iconv-lite` 对 GBK 编码进行硬核解码，采用循环缓冲区（Ring Buffer）/ 固定双端队列存储日志预览，引入绝对超时以清除 TUI 全屏僵尸进程。

**非目标:**
1. 首期不通过 `tree-sitter` 等库进行命令的抽象语法树（AST）静态安全解析。
2. 首期不把命令静态解包拦截作为核心安全防线，核心安全防线依旧寄托于物理路径 Resolve 与未来的系统沙箱化隔离环境。
3. 不在首期实现容器级（Docker/Modal）沙箱物理降权执行环境的搭建。

## 架构决策

### 1. 有限状态机 (FSM) 与唯一状态清算机制
* **状态流转设计**：内存中的 `activeTasks` 表维护每个任务的状态：
  ```
  [PENDING] ──> [RUNNING] ──┬──> [STALLED] (Stall Watchdog, 可恢复或强杀)
                            ├──> [COMPLETED] (OS exitCode = 0)
                            ├──> [FAILED] (OS exitCode != 0)
                            └──> [KILLED] (主动中断)
  ```
* **原子锁防竞态**：设计原子性修改状态的 `transitionTaskState(taskId, nextState)` 函数。在状态向终态（`COMPLETED` / `FAILED` / `KILLED` / `STALLED`）流转时，必须加写锁并 atomically 置 `notified = true`。
* **唯一通告与清理**：状态一旦流转到终态，立刻注销当前任务关联的全部 Watchdog 定时器与 Watcher 监听，后续并发或延迟到达的任何 Watcher 日志行匹配直接抛弃，确保只发出一次终态 XML 通知。

### 2. 频控熔断的 Watcher 实时事件流
* **匹配与冷却**：行级扫描终端输出流。匹配到 `watch_patterns` 时，若处于 15 秒的冷却期窗口（Rate Limit）内，则立刻通知；否则拦截延迟，避免高频日志泛滥。
* **断路器降级 (Circuit Breaker)**：若单 Session 发生匹配丢弃次数过多（如连续 Strike 3 次），说明日志正在刷屏。系统自动触发全局断路器，永久禁用该任务的 Watcher，自动退化为“只有当进程退出时才发送 notify_on_complete 终态通知”，彻底防范 Token 被冲垮。

### 3. Ansi-Strip 与 I18N Stall Watchdog (卡死看守)
* **监控机制**：看守定时器每 5 秒监控一次磁盘托管 `.log` 文件的大小变化。若大小连续 30 秒未增长，触发卡死校验。
* **GBK 支持与 I18N 解码**：承认 Node.js 内置解码缺陷。在 Windows 下，系统将在启动前通过 `chcp` 探测当前活动代码页。如果识别为 936（GBK）等非 UTF-8 编码，必须引入 **`iconv-lite`** 转译库对读取的尾部 Buffer 执行 `iconv.decode(buffer, 'gbk')` 解码，彻底解决控制台中文乱码导致正则失效的问题。
* **文本清洗 (`strip-ansi`)**：从日志尾部读取 1024 字节并解码后，通过正则清除所有 ANSI 转义和终端控制序列，还原纯净控制台文本：
  `\u001b\[[0-9;]*[a-zA-Z]`
* **多语言泛化正则匹配**：
  使用泛化的 looksLikePrompt 正则进行匹配：
  `/(y\/n)|continue\?|overwrite\?|按任意键继续|是否确定/i`
  匹配成功则立即强制调用进程树强杀，流转至 `STALLED` 并告警。
* **TUI 漏判盲区与绝对超时兜底 (Absolute Timeout)**：
  如果子进程意外启动了 `vim`、`nano`、`less` 等基于 TUI（文本用户界面）的全屏程序，由于它们不输出 `y/n` 等文本提示符，看守正则将面临失效。为此，状态机中必须定义一个任务**绝对硬超时门禁（如 30 分钟无条件硬超时）**。超时一旦触发，无论是否有日志变动，状态均流转为 `FAILED` 并强杀僵尸进程，彻底防范服务器资源被耗尽。

### 4. Spilling 内存滚动缓冲区优化 (Ring Buffer)
* **Spilling 物理重定向**：进程启动时直接通过 `createWriteStream` 将所有标准/错误输出异步重定向写入本地日志。
* **内存 GC 防碎片机制**：
  **严禁** 在流的 `data` 回调中采用 `Buffer.concat().slice(-50000)` 等暴力切片拷贝操作（V8 对此种切片的父大内存块引用不会释放，易引发严重的 GC 内存碎片崩溃）。
  必须实现一个固定最大长度的**循环缓冲区 (Ring Buffer) 或固定大小的双端队列 (Deque)** 结构，仅缓存最新写入的固定数量的数据页 block。当需要获取 tailText 时，再在终态通过 lazy 拼接解析，从而保护 Node.js 主事件循环免受 GC 停顿拖累。

## 风险与权衡

* **风险一：纯正则静态命令拆包的脆弱性与 Redos 风险**
  * **权衡取舍**：我们接受静态命令拆包极易被 Shell 混淆逃逸绕过的事实。因此，我们**不对静态命令拆包做强硬拦截拦截**，而是将其**降级为 Advisory Warning（辅助静态警告）**。真正的安全性由物理路径 resolve（展开 symlink）跨盘比对和未来的沙箱层下沉保障，避免在应用层进行无谓且危险的正则猫鼠游戏。
* **风险二：Watcher 高频触发打爆大模型上下文**
  * **权衡取舍**：如果任务狂刷错误日志（如无限循环抛出 Exception 命中 pattern），极易疯狂唤醒模型。对此，我们设计了**单 Session Rate Limit + 全局熔断断路器**，牺牲实时性来保证财务和计算上下文安全。
* **风险三：Windows 多语言下的字符乱码和卡死误判**
  * **权衡取舍**：中文 Windows 平台默认的 GBK 编码易引起英文字符乱码导致正则失效。我们必须引入活动代码页字符集自动探测或指定编码解码层，在正则检查前执行统一的文本纯净化处理，权衡结果是增加极小幅度的读取开销，换取在 Windows 下近 100% 的提示符识别率。

## [调试修正] 边界问题与风险补正 (2026-06-20)

在 verify 静态扫描与增量人工评审中，发现并修正了以下设计缺陷以达成更优的底层健壮性：

1. **头部 Chunks 主动释放与 Deque 纯净类型**：为了真正消除超大日志中由于 `headChunks` 队列导致的物理 Buffer 引用积压，当 `headBytes >= 50KB` 时，引擎会立即一次性进行 concat 和 decode 缓存进 `taskInfo.headText`，并清空 `headChunks`。由于 TS 编译器下 Buffer 与 Uint8Array 的 ArrayBufferView 冲突，中间缓存队列声明为 `unknown[]`，在 `Buffer.concat` 时进行 `as Uint8Array[]` 的显式类型转换，在 `length` 读取时转为 `Uint8Array`，规避了 ESLint `no-explicit-any` 和 `tsc` 的双重编译限制。
2. **废弃死代码 notified**：FSM 有限状态机的单向终态约束已完全具备唯一通告的原子锁作用，故完全废弃了 `notified` 字段及其死代码逻辑。
3. **Stall Watchdog 滑动周期检测**：如果 30 秒无增长且未命中交互正则 looksLikePrompt，不再清零 `noGrowthSeconds`，而是将其回退至 `25`。由于看守以 5 秒为一个周期，此举使得看守在第 30 秒之后每隔 5 秒便会以滑动窗口重新检测一次，彻底消除了每次都需要重新等待 30 秒的检测盲窗。
4. **Tool 层 onNotification 事件通道连通**：在 `ExecuteCommandTool` 的 execute 阶段，为 `runCommandEngine` 的 options 传入初始回调，把通知事件向控制台或系统会话做首层连通，以便未来打通系统消息队列。

