## 背景

智能体运行时框架在调度 Hook 中间件（在 `src/brain/plugins/plugin-runner.ts` 中的 `runHookPipeline`）时引入了 Immer，用以沙箱化保护 Context 和 LLM 请求/响应数据。
由于 Immer 默认会递归冻结（Deep Freeze）产生的状态树以保证不可变性（Immutability），在 Hook 管道执行完毕后，主 Context 接收到的会话消息历史数组 `history` 变成了深度冻结的只读数组。
这与底层的面向对象（OOP）可变状态（Mutable State）架构设计发生冲突。当外部业务代码（如 `agent-loop.ts`）在退出沙箱后调用 `this.context.addMessage()` 时，其内部的 `this.messageHistory.push(message)` 修改操作会抛出 `TypeError: Cannot add property <index>, object is not extensible`。

此前探讨过仅在 Context 提交时进行浅拷贝 `[...history]` 数组解冻的方案（方案 B）。但这只是治标不治本的方案。因为被冻结的不仅是数组，还包括数组内的每一条 `message` 及其嵌套的 `tool_calls` 子对象。外部在对这些消息的属性（如流式正文合并 `message.content += chunk`）进行写入修改时依然会崩溃。

## 目标与非目标

**目标:**
- 全局关闭 Immer 的自动冻结机制，恢复 Context 状态的常规 JS 对象行为。
- 保证外部所有的流式响应合并、工具补丁修改及常规 `push`/`pop` 消息操作在 Hook 管道外执行时不再因为 object readonly/not extensible 而崩溃。
- 精简代码，移除或规避为了防御性解冻而引入的浅/深拷贝样板代码。

**非目标:**
- 本变更不重构既有的 OOP 可变状态架构为声明式 Immutable 状态管理架构。
- 不修改插件或中间件本身的执行沙箱机制，Immer 依然通过 Proxy 沙箱拦截修改并产生 Patch，仅在 finishDraft 时不再递归冻结。

## 架构决策

- **架构选型：全局调用 `setAutoFreeze(false)`**
  - **决策**：在 [plugin-runner.ts](file:///d:/Projects/MyAgent/src/brain/plugins/plugin-runner.ts) 的文件头部导入 `setAutoFreeze` 并执行 `setAutoFreeze(false)`。
  - **理由**：
    1. **范式对齐**：Agent 后端状态管理的核心基于 `SessionContext` 可变类。在此场景下，关闭全局自动冻结是最自然地契合该可变状态架构的设计，消除 Immutable 对系统运行时突变代码的干扰。
    2. **彻底解决隐患**：避免了“外层数组可变，内层数据冻结”的脏状态，杜绝未来任何在业务层对已有消息（如 message 属性更新）进行修改时触发的不可预知异常。
    3. **性能提升**：大模型会话历史可能包含极长文本，关闭自动冻结能免除 `finishDraft` 时递归深度扫描并冻结整个状态树的 CPU 开销，在大上下文场景下客观优化了时延。
    4. **方案简洁**：无需在 `plugin-runner.ts` 或者各级提交层级中编写丑陋的数组或对象解冻的深浅拷贝样板代码。

## 风险与权衡

- **[潜在风险]**：关闭自动冻结后，如果中间件/插件开发者编写了不规范的直接突变外部原始对象（而非在 Draft 沙箱内修改）的代码，Immer 将无法通过运行时抛出 `TypeError` 异常来即时预警和阻止这种隐式篡改。
  - **[缓解策略]**：建立明确的中间件开发规范与代码质检机制，强制通过 PR 和 Specs 检查是否所有的 Hook 变动都仅通过对沙箱 Draft（如 `sandboxContext.history` 等）的操作来产生，而非直接篡改全局变量或外部传入参数。
