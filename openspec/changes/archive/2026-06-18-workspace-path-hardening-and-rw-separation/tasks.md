## 1. 物理真实绝对路径（RealPath）加固锁定

- [x] 1.1 修改 [loader.ts](file:///d:/Projects/MyAgent/src/config/loader.ts)，在读取 `AUTHORIZED_WORKSPACE_DIR` 配置后，强制使用 `fs.realpathSync` 物理展开并锁定为真实的物理绝对路径。
- [x] 1.2 修改 [base.ts](file:///d:/Projects/MyAgent/src/action/native-tools/base.ts) 的 `initWorkspace`，使用 `fs.realpathSync` 处理 rootDir 以防虚拟挂载漂移；重构 `secureResolvePath`，对传入的 `targetPath` 使用 `fs.realpathSync` 解析为真实物理绝对路径后再与工作区路径比对，阻断符号链接/Junction 穿透。
- [x] 1.3 修改 [terminal-guard.ts](file:///d:/Projects/MyAgent/src/action/native-tools/terminal-guard.ts) 的 `validateCwd`，在拼接进程 cwd 后，强制使用 `fs.realpathSync` 标准化物理路径并执行边界验证。

<!-- checkpoint: npm run build -->

## 2. 文件系统 API 路径校验读写隔离

- [x] 2.1 在 [base.ts](file:///d:/Projects/MyAgent/src/action/native-tools/base.ts) 中重构并提供 `secureResolveReadPath` 与 `secureResolveWritePath` 入口，支持依据 Session 内存中的动态读写临时白名单（`temporaryReadWhitelist` 与 `temporaryWriteWhitelist`）进行放行判定。
- [x] 2.2 重构 [file-system.ts](file:///d:/Projects/MyAgent/src/action/native-tools/file-system.ts)：修改 `readFileTool` 与 `listFilesTool` 使其调用 `secureResolveReadPath`；修改 `writeFileTool` 与 `editFileTool` 使其调用 `secureResolveWritePath`。

<!-- checkpoint: npm run test -->

## 3. 终端敏感命令与别名过滤、卡关与 Ask 审批

- [x] 3.1 在 [terminal-guard.ts](file:///d:/Projects/MyAgent/src/action/native-tools/terminal-guard.ts) 中实现针对 Windows PowerShell 的高危别名及写倾向正则（匹配 `Remove-Item`、`del`、`rd`、`rm` 及参数写操作）。定义无害只读白名单（如 `git status`、`git diff`）。
- [x] 3.2 将 `ToolConstants` 常量类提升至全局 `common` 模块的 [constants.ts](file:///d:/Projects/MyAgent/src/common/constants.ts)；重构 [virtual-mcp.ts](file:///d:/Projects/MyAgent/src/action/virtual-mcp.ts) 与相关引用以消除魔法字符串并解耦跨模块依赖。
- [x] 3.3 升级 [HumanApprovalPlugin.ts](file:///d:/Projects/MyAgent/src/brain/plugins/HumanApprovalPlugin.ts)，将比对方式升级为特征能力集（基于全局 `common` 模块内的 `ToolConstants` 静态常量），并在 `BeforeTool` 中应用文件越界 Ask 动态授权。

<!-- checkpoint: npm run test -->

## 4. 静态代码规范质检修复 (ESLint Linting Clean)

- [x] 4.1 修复 [base.ts](file:///d:/Projects/MyAgent/src/action/native-tools/base.ts) 中不必要的正则斜杠转义字符（`no-useless-escape` 错误）。
- [x] 4.2 修复 [HumanApprovalPlugin.ts](file:///d:/Projects/MyAgent/src/brain/plugins/HumanApprovalPlugin.ts) 中变量 `hasAuth` 和 `accessType` 在声明时冗余赋值导致的 `no-useless-assignment` 错误。

<!-- checkpoint: npm run lint -->

## 5. 解除 ReAct Generator 原地挂起通信死锁 (Deadlock Resolution)

- [x] 5.1 在 [ApprovalService.ts](file:///d:/Projects/MyAgent/src/brain/services/ApprovalService.ts) 中增加回调函数处理器 `registerApprovalHandler`。在 `wait()` 方法参数中增加元数据 `toolCall`、`allowedPrefix` 与 `message`，并在 Promise 挂起前同步触发此回调。
- [x] 5.2 在 [HumanApprovalPlugin.ts](file:///d:/Projects/MyAgent/src/brain/plugins/HumanApprovalPlugin.ts) 中更新 `service.wait` 的调用契约，传入相关工具元数据与提示消息。
- [x] 5.3 在 [facade.ts](file:///d:/Projects/MyAgent/src/interface/facade.ts) 构造函数中向 `session.approvalService` 注册回调提问处理器，实现同步非阻塞弹窗并 resolve 唤醒。
- [x] 5.4 修复 [HumanApprovalPlugin.ts](file:///d:/Projects/MyAgent/src/brain/plugins/HumanApprovalPlugin.ts) 中第 129 行传入 `safePrefix`（`string | null`）到 `service.wait`（只接收 `string | undefined`）引发的 TS2345 编译错误。
- [x] 5.5 重构 [facade.ts](file:///d:/Projects/MyAgent/src/interface/facade.ts) 的 `registerApprovalHandler`，移除解决审批后多余的 `this.listener.resume()`。
- [x] 5.6 重构 [facade.ts](file:///d:/Projects/MyAgent/src/interface/facade.ts) 中的普通对话处理分支，利用 `try-finally` 实现生成周期内输入监听的 `pause` 与 `resume` 闭环。
- [x] 5.7 修改 [input-listener.ts](file:///d:/Projects/MyAgent/src/interface/io/input-listener.ts)，引入 `isPaused` 状态标志位，在 `pause()` 方法中设为 `true`，在 `resume()` 与 `start()` 中设为 `false`，并在 `line` 事件回调中检测拦截以物理丢弃任何挂起期间由于共享 Stdin 流被重新唤醒而导致的残留回车输入，彻底阻断并发写入 Context 的忙锁错误。

<!-- checkpoint: npm run test -->
