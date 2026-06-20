# 探索主题: 借鉴 Hermes、Claude Code、OpenCode 与 OpenClaw 提升智能体能力与安全防护

## 1. Problem Definition (问题定义)
在进行长周期、复杂的异步任务开发（如项目编译、依赖安装、大包测试）时，`MyAgent` 现有的同步终端执行机制存在重大短板：
1. **缺乏事件驱动唤醒**：任务转入后台后，大模型无法即时知晓其执行成败，不得不高频轮询，导致 Token 消耗巨大，且开发流被打断。
2. **缺乏防交互卡死设计**：后台任务如果遇到意料之外的 `[y/n]` 或 `Press any key` 等命令行确认，会在后台永久挂起，造成逻辑死锁或资源泄露。
3. **缺少技能库的自整理**：技能随使用增加而变得极其碎片化，增加 Token 损耗。
4. **命令安全沙箱防护薄弱**：目前的路径和命令过滤仅停留在基本的字面字符串黑名单比对，一旦遇到嵌套执行（如 `env x=y sh -c "rm -rf /"`）或符号链接挂载（Symlink），极易被穿透绕过。

为了攻克这些痛点，我们对业界四大前沿 Agent—— **Hermes Agent**、**Claude Code**、**OpenCode** 与 **OpenClaw** 进行了深入源码级调研，提炼出可供 `MyAgent` 借鉴的终端长任务及安全调度防护方案。

## 2. Key Findings & Research (关键发现与调研)

### 2.1 Hermes Agent 的后台与看守机制 (`tools/process_registry.py`)
- **多后端进程注册**：设计了独立的进程注册表，支持 local 终端以及 Docker、SSH、Modal 等云沙箱后端，通过向容器写入 PID 和 Log 文件进行隔离和控制。
- **Watch Pattern 与频控熔断**：支持指定 `watch_patterns` 触发实时通知，同时配置了 **Per-Session Rate Limit** 与 **Global Circuit Breaker** 频控网。一旦遭遇日志刷屏，会自动将 Watcher 降级为退出通知，防止通知风暴榨干 Token。
- **技能 Curator**：在闲置期采用独立辅助模型进行静态技能 Curation（Umbrella-Building），自动合并冗余技能。

### 2.2 Claude Code 的任务状态机 (`tasks/LocalShellTask/LocalShellTask.tsx`)
- **防交互卡死看守狗 (looksLikePrompt / startStallWatchdog)**：Claude Code 会对后台任务启动一个 Stall Watchdog（卡死看守）。每 5 秒监测一次文件大小，如果发现文件**大小停止增长**且持续 45 秒以上，就会读取日志末尾 1024 字节。若内容符合正则（包含 `(y/n)`、`Continue?`、`Press any key` 等），立即通过 `enqueuePendingNotification` 抛出卡死警告，提示智能体换用非交互命令重跑，彻底防止后台死锁。
- **自动后台化预算**：限制前台最大等待时间 `ASSISTANT_BLOCKING_BUDGET_MS = 15,000ms`，超时后自动剥离至后台。
- **XML 状态通告机制**：进程结束时无条件发布 `<task_notification>` XML，通知主 ReAct 循环进行任务清算与状态转移。

### 2.3 OpenCode 的函数式并发设计与技术债 TODO (`packages/core/src/tool/bash.ts`)
- **外部路径提权审批**：在执行命令前，通过 `LocationMutation` 与 `PermissionV2` 对命令参数中的绝对路径进行静态扫描，若引用了非授权的工作区外部目录，则自动触发警告与提权申请。
- **面向未来的 parity 规划**：包括 **Stream full shell output into managed storage**（大日志分流落盘，只向模型返回头尾预览）以及 **Persist background job status and define restart recovery**（后台任务状态持久化以抵御崩溃重启）。

### 2.4 OpenClaw 的命令安全机制与套娃注入分析 (`src/infra/command-analysis/risks.ts`)
- **嵌套载体剥离与解释器解析 (Command Carrier Parsing)**：OpenClaw 极其关注防命令逃逸安全。在大模型发送执行命令时，它不仅扫描前缀，还会递归剖析命令的抽象语法树（AST）。
  1. **环境前缀剥离 (`stripLeadingEnvAssignments`)**：把类似 `NODE_ENV=production npm run build` 前缀的环境变量声明剥离，识别出真实的二进制主体。
  2. **套娃解包 (Unwrapping Carriers)**：递归解析通过 `env`、`sudo`、`exec`、`xargs`、`find -exec` 等“嵌套载体”包裹的真实命令，防止其以白名单命令作为伪装。
  3. **内联求值检测 (`detectInlineEvalArgv`)**：深度识别通过 `python -c "..."` 或 `node -e "..."` 等内联解释器语法绕过过滤的行为。
  4. **环路依赖防御**：利用 `seenArgv` 集合防止大模型通过特殊的循环嵌套构造将安全分析器打崩（OOM 或死循环）。

## 3. Design Adjustment & Corrective Actions (设计调整与修正方案)

针对异步终端方案在首期落地中的可行性与潜在风险，我们制定了以下三大技术修正方针：

### 3.1 针对“静态命令拆包流于猫鼠游戏”的修正：防线下沉与安全降级
- **痛点**：依靠应用层正则表达式过滤去对抗 Shell 层出不穷的逃逸技巧（如 `eval`, `base64` 解码执行、混淆变量拼接）极其脆弱，甚至容易引发 ReDoS 漏洞。
- **修正方针**：首期**不将“静态命令拆包”作为硬核安全边界**。OpenClaw 的嵌套解包与环境变量剥离仅作为**前置静态辅助预警（Advisory Warning）**。真正的底层安全防御下沉至执行环境层，首期仅通过严格的物理绝对路径 realpath 校验与跨盘拦截进行约束，后续版本通过 Docker/沙箱环境降权执行进行最终物理物理硬化。

### 3.2 针对“多状态机制叠加引发竞态冲突”的修正：原子有限状态机 (FSM) 状态清算
- **痛点**：Watcher 实时模式匹配、Stall Watchdog 卡死挂起与 OS 退出兜底三个异步事件同时并发触发，若缺乏单一清算逻辑，极易导致对大模型发送重复、甚至矛盾的并发通告，打乱大模型的推理上下文。
- **修正方针**：在终端引擎层引入**原子锁有限状态机（FSM）**，设定清晰的单向终态（`COMPLETED` / `FAILED` / `KILLED`）。一旦有任何事件触达状态变更，立刻原子锁置为 `notified = true` 并强行注销该任务的所有关联定时器与监听器，确保向大模型发送的 XML 状态通知**有且仅有一次**，且状态流转不可逆。

### 3.3 针对“Watchdog 提示符匹配失效”的修正：Ansi-Strip 与 I18N 提示符泛化
- **痛点**：真实的控制台输出充斥着 ANSI 颜色转义字符（如 `\u001b[31m`）与非英文环境提示符（如中文 Windows 的“按任意键继续...”，GBK 乱码等），直接匹配 `(y/n)` 存在严重的漏报盲区。
- **修正方针**：
  1. **文本预处理**：看守狗读取日志后，必须前置使用 `strip-ansi` 算法清除所有 ANSI 控制字符，还原纯净文本。
  2. **多语言词库泛化**：扩充 `looksLikePrompt` 匹配词库，支持中英文常见交互提示符（如 `按任意键继续`、`是否确定`、`确认 (Y/N)`、`确认 [y/n]`）。
  3. **编码探测**：针对 Windows 平台，拉取 stdout/stderr 流时强制按系统默认活动页编码（UTF-8/GBK）自动探测解码，防范乱码干扰匹配。

## 4. Design Comparison & Recommendations (方案对比与推荐)

使用 Markdown 表格进行多维度架构对比：

| 评估维度 | 方案 A: Watcher + Completed (Hermes) | 方案 B: 方案 A + Stall Watchdog (Claude Code) | 方案 C: 方案 B + 日志分流 (OpenCode) | 方案 D: 修正后的终端异步执行状态机 (本期推荐) |
| :--- | :--- | :--- | :--- | :--- |
| **核心特征** | 主动字面日志匹配，进程退出通知 | 消除后台输入等待死锁 | 大日志落盘分流，防打爆上下文 | **状态机单向锁 + Ansi-Strip + 安全拆包辅助化 + 日志分流** |
| **竞态防范** | 无 | 低 | 低 | **极高**（原子锁 FSM 保证唯一通知） |
| **匹配健壮性** | 低 | 中（直接匹配易受转义符干扰） | 中 | **极高**（引入前置 strip-ansi 与 I18N 泛化） |
| **安全实效性** | 一般 | 中 | 中 | **极高**（不盲信正则，辅助预警，防线下沉） |

### 推荐路径 (Recommended Path)
首期核心目标为实现 **方案 D（修正后的终端异步状态机）**，其具体的落地规格如下：
1. **进程层状态机**：使用有限状态机（FSM）统一控制后台任务的生命周期，状态一旦变更为终态即锁定 `notified = true`。
2. **Watcher 唤醒与防刷熔断**：配置 `watch_patterns` 触发即时唤醒，引入 Per-Session Rate Limit（如 15 秒冷却）。
3. **Stall Watchdog**：对后台挂起任务，每 5 秒监测大小。若 30 秒无增长，对提取的尾部文本进行 `strip-ansi` 并做中英文 `looksLikePrompt` 正则校验，匹配成功则发出警告并原子性注销。
4. **日志 Spilling**：重定向流式写入，只向模型返回截断的 100KB 头尾预览。
5. **静态安全过滤**：废弃 `startsWith`，将 OpenClaw 的嵌套载体解包定位为静态建议预警（Advisory Warning），物理绝对路径 `realpath` 比对限制跨盘。

## 5. Constraints, Risks & Unknowns (约束与风险)
- **命令语法解析难度**：在 Node.js 中，不使用 tree-sitter 而是依靠正则和分词解析 `shell-argv` 时，如果遇到非常复杂的 Shell 管道嵌套和重定向，载体剥离可能存在边缘失效，需保持防御性降级。
- **熔断防御**：当大量并发任务时，高频通知可能冲垮大模型注意力，需强制设置 Session/Global 冷却时间。
- **异步事件通知与消息总线未完全闭环（已知限制与遗留项）**：
  - **现状**：目前 `terminal.ts` 中的 `onNotification` 实现属于框架占位骨架，其具体动作仅为向 `process.stdout` 写入日志。由于大模型在后台任务运行期间已经返回（同步调用已 resolved），单纯的控制台 stdout 输出大模型是无法感知的，导致当前 Watcher 日志匹配和 Stall 卡死强杀的“提前唤醒”事件无法真正打断主 ReAct 推理链路，也无法主动拉回大模型的注意力。
  - **未来演进**：未来需在此连通一个向 `agent-loop` 注入异步消息的消息队列或总线管道（例如调用类似 `messageQueueManager.push(...)` 接口），使系统事件能以系统角色的上下文消息喂给大模型，闭环“主动唤醒”的最终产品价值。

## 6. Rejected Solutions (否决方案)
- **无频控的日志实时推送**：拒绝将后台进程的所有 stdout/stderr 实时作为 Message 塞回大模型，这会由于 Token 暴涨导致费用激增。
- **纯字面前缀过滤（Lexical Filter）**：否决仅依赖前缀的静态检测，因为极易通过 `env SUDO_FORCE=1 sudo sh -c "..."` 被越权穿透，必须在此轮方案中予以淘汰并采用载体解包防护。
