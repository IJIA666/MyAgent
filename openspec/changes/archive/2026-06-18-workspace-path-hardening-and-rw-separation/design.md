## 背景

当前智能体的安全沙箱设计非常简易，面临以下关键安全威胁：
1. **路径解析不够物理安全**：路径校验工具仅对入参进行粗暴的相对路径拼接 `resolve` 与字符串 `startsWith` 判断，没有使用操作系统底层的 `fs.realpathSync` 展开真实的物理路径。攻击者可以在工作区内创建一个指向宿主机高危系统目录（如 `C:\Users`）的符号链接（Symlink）或挂载点（Junction），即可通过相对路径验证直接读写宿主机机密文件。
2. **终端执行缺乏过滤与控制**：终端命令工具 `executeCommandTool` 直接把参数传入进程引擎，完全不分析命令本身的读写倾向与路径参数；并且当前的复合连接符正则十分简陋，容易在 Windows/PowerShell 下引发绕过或误杀。
3. **读写权限高度混淆**：文件 API 共享同一个校验函数，无法区分读与写权限，不利于细粒度安全策略落地。
4. **一刀切的中断机制**：沙箱一旦判定越界，采取直接 `throw Error` 终止任务的做法，缺乏向用户进行交互式动态申请授权（`Ask`）的降级恢复手段，损害了多任务编排的连贯性。

## 目标与非目标

**目标:**
1. **符号链接与挂载点防护**：通过引入操作系统级的 `fs.realpathSync`，强制锁定工作区及操作目标的真实物理绝对路径，阻断一切符号链接逃逸。
2. **校验路径读写分离**：将校验核心重构为 `secureResolveReadPath` 与 `secureResolveWritePath`，使高层文件 API 实现显式的读写隔离判定。
3. **Windows 特化 Shell 正则拦截与安全降级**：废弃 Bash 专用的 `shell-quote`。针对 PowerShell 别名机制，编写支持 `Remove-Item`、`del`、`rd` 等风险别称过滤的轻量级正则。除明确无害的只读白名单命令外，凡是有写盘倾向的、管道混写的、或未识别的终端命令，一律强制安全降级为 `behavior: 'ask'`，拉起人机交互审批，消除别名混淆风险。
4. **交互式审批与临时白名单**：重构 `HumanApprovalPlugin` 提问交互流。当文件 API 发生越界或者终端命中有写入倾向时，支持挂起任务并通过 `Ask` 挂起向用户动态申请权限；若用户批准，则将该路径临时加入内存 Session 读写白名单。

**非目标:**
1. **引入重型 AST 解析引擎**：本阶段不在 Windows 环境中加载 `web-tree-sitter` 的 WASM 语法树解析，亦不为 POSIX 引入 `shell-quote`。
2. **系统内核层受限沙箱隔离**：本设计局限于 Node.js 应用层防护，不涉及 Windows Access Token 强降权、NTFS ACL 修改或 WFP 网络出站硬封锁。

## 架构决策

1. **统一物理路径标准化校验器 (RealPath Validator)**
   在 [base.ts](file:///d:/Projects/MyAgent/src/action/native-tools/base.ts) 中重构校验机制。初始化授权工作区时，通过 `fs.realpathSync` 标准化物理路径。在前置校验任何目标路径前，强制首先调用 `fs.realpathSync` 消除其包含的所有符号链接和 `..` 相对位移，再执行前缀 `startsWith` 判断。
   *理由*：物理绝对路径唯一性校验是防止符号链接/挂载点逃逸与相对路径漂移的最有效手段。

2. **路径读写独立分离与 Session 级临时白名单**
   提供 `secureResolveReadPath` 与 `secureResolveWritePath` 两个独立入口。在 Session 上下文（Context）中维护两个内存 Set：`temporaryReadWhitelist` 和 `temporaryWriteWhitelist`。
   * 当高层文件 API 执行时，若目标路径超出常规工作区物理边界，不直接报错，而是首先检查内存中的 Session 临时白名单。
   * 若不满足白名单，调用 `approvalService` 拉起 `Ask` 交互提问。经用户确认后，将路径标准化加入临时白名单并放行；若用户拒绝，则抛出 Error 阻断。

3. **终端“宁错杀不放过”安全降级机制**
   在终端执行时，放弃任何在 Windows 环境下不兼容的 Bash 词法分析。终端拦截判定逻辑更新为：
   * **安全只读白名单放行**：定义严格的无副作用只读命令字白名单（如 `git status`、`git diff`、`vitest` 且没有包含管道符及重定向字符 `>`）。凡是命中白名单的原子命令，直接放行。
   * **敏感命令及别名正则拦截**：使用正则匹配常见的高危动作命令及别名（如 `rm`, `del`, `rd`, `ri`, `rmdir`, `Remove-Item` 等）。
   * **安全降级卡关**：对于任何包含上述敏感正则的命令，或任何不在只读白名单内、包含写重定向、以及未识别的复杂脚本，一律强制将安全等级回退至 `behavior: 'ask'` 挂起状态。通过交互式弹窗，将包含潜在风险的完整命令展示给用户进行最终审核裁决。

## 风险与权衡

1. **[风险点：PowerShell 动态反射与动态代码评估绕过正则]**
   * *缓解策略*：采用保守策略。任何在白名单之外、含有未明确只读标记的指令，全部一律降级到 `behavior: 'ask'`。阻断包含 `Invoke-Expression`、`iex` 等在内的动态执行关键字。在静态分析不确定的情况下，牺牲极少量的交互体验以确保物理绝对安全。
2. **[风险点：临时白名单生命周期与内存泄漏]**
   * *缓解策略*：临时白名单完全保存在与当前会话生命周期绑定的内存对象中，不写入任何物理磁盘配置文件。一旦 Session 被关闭或销毁，动态白名单自动清空释放，实现无污染环境治理。
3. **[风险点：误拦截常规开发构建命令打断工作流]**
   * *缓解策略*：允许对智能体日常开发最频繁调用的 `npm run dev`/`npm run build` 等指令配置特化的局部白名单规则，或者仅在其试图越界修改工作区以外文件时才触发 `Ask` 卡关，实现体验与安全的最大化平衡。

## [调试修正] 统一定义全局 common 模块与工具常量以消除魔法值与耦合
为了解决 `BeforeTool` 钩子中由于工具名称大小写/重名失配（如 `execute_command` 与 `executeCommandTool`）导致安全拦截逻辑被跳过的隐患，同时避免高阶插件模块（`brain`）与底层工具实现模块（`action`）之间发生深层越权依赖，系统决定建立一个独立的全局公共分包 [src/common/](file:///d:/Projects/MyAgent/src/common/) 模块。在该模块下的 [src/common/constants.ts](file:///d:/Projects/MyAgent/src/common/constants.ts) 中定义 `ToolConstants` 静态常量类管理所有核心契约标识，保持依赖层级单向向下依赖，彻底消灭硬编码魔法值字符串并使架构关系清晰规范。

## [Amend 修正] 升级 ApprovalService 事件分发机制以解决 Generator 原地阻塞死锁
在 ReAct 推理循环的异步 Generator 管道模型中，插件在 `BeforeTool` 钩子中执行 `await service.wait(id)` 原地异步挂起等待审批时，底层的 `runHookPipeline` 不会返回。这导致已通过 `context.emitEvent` 缓冲到局部的 `suspend` 挂起事件由于生成器在执行中途被挂起，而无法在 pipeline 外被 `yield` 给外层消费者消费。为了解决这一由于 JS 异步阻塞特性导致的通信死锁问题：
- 系统决定将 `ApprovalService` 改造为支持通过注册同步/异步事件回调直接打通外部。
- `ApprovalService` 新增 `registerApprovalHandler(handler)` 接口，并在 `wait()` 执行进入 Promise 挂起前实时、同步地调用此 Handler 分发包含 `toolCall`、`allowedPrefix`、`message` 的完整审批上下文元数据。
- 终端展示门面 [facade.ts](file:///d:/Projects/MyAgent/src/interface/facade.ts) 在初始化时将向该 service 注册其专属的交互提问处理器。一旦发生卡关，不依赖 `for await` 事件流的 `yield`，而是直接在此同步触发并渲染卡关弹窗，等待用户裁决后 `resolve` 内核，从而优雅安全地解除死锁。

## [Amend 修正] 重新规范 InputListener 生命周期以解决并发输入冲突
在审批卡关解除挂起后，若 `registerApprovalHandler` 内部立即调用 `this.listener.resume()` 恢复输入监听，会导致终端在 LLM 大循环未结束前提前打印 Prompt 提示符。此时用户输入的任何空白或命令残留会由于 context 处于忙锁状态（`isProcessing === true`）触发 `Cannot modify SessionContext` 崩溃。为此：
- 移除 `registerApprovalHandler` 中解决后的 `this.listener.resume()` 抢占式恢复调用。
- 重新规范 [facade.ts](file:///d:/Projects/MyAgent/src/interface/facade.ts) 的输入控制生命周期，在普通对话分支的 `handleLineSubmit` 开头调用 `pause()`，并在 `finally` 块中统一调用 `resume()` 恢复监听并打印提示符，实现与斜杠指令对齐的输入隔离流，彻底消除忙锁冲突。

## [调试修正] 引入 InputListener 物理挂起标志位以防御多路 Readline 数据穿透
由于 Node.js 多个 `readline.Interface` 实例共享底层的 `process.stdin` 流，当在 `BeforeTool` 等卡关提问期间创建一个临时的 `readline` 实例并调用其 `resume()` 唤醒底层输入流以读取用户的审批决定时，已经被 `pause` 的全局 `InputListener` 关联的 `readline` 实例也会因为底层流被唤醒而收到同样的 `data`/`line` 信号。为物理阻断该数据穿透问题：
- 在 `InputListener` 中加入 `isPaused` 私有标志位，并在 `pause()` 和 `resume()` 中切换该标志。
- 在 `'line'` 事件处理器头部引入 `if (this.isPaused) return;` 阻断器，强行丢弃挂起期间产生的所有回车及无效输入，确保不会并发调用 `handleLineSubmit` 触发 Session 忙锁崩溃。


