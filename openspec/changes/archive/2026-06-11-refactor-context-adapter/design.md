## 背景

在当前的 `src/brain/session.ts` 中，`SessionManager.chat()` 的主循环中硬编码了一套上下文组装逻辑（包括截取最新的 User 消息、临时挂载 `<transient_skill>` 系统指令）。随着后续系统演进，系统需支持异构模型的提示词缓存方案（如 Anthropic 的 `cache_control` 块隔离），并且在长周期任务中需引入水位线监控（Token Analytics）和历史折叠（Mid-Context Compression）。如果继续将组装逻辑保留在调度层，代码的可维护性与扩展性将受到限制。

## 目标与非目标

**目标:**
- 定义统一的 `ContextAdapter` 接口规范。
- 实现基础的 `DefaultContextAdapter`，接管目前 `session.ts` 中的尾部入栈逻辑。
- 重构 `SessionManager`，使其依赖于 `ContextAdapter` 进行提示词组装。
- 为未来接入“Token 嗅探器”和“中部压缩拦截器”预留 Hook 或组合位置。

**非目标:**
- 本次变更**不**实现具体的水位线监控与压缩算法。
- 本次变更**不**涉及子代理委派（Subagent Forking）的实际实现。
- 本次变更**不**修改底层的 `LlmDriver` 推理引擎。

## 架构决策

1. **提取 `ContextAdapter` 接口**: 
   在 `src/brain/` 目录下（或新增 `adapters` 子目录）定义 `ContextAdapter` 接口。核心方法定义为 `assemble(baseHistory, transientContext?)`，返回组合好且安全的完整提示词流，供 Driver 直接使用。
2. **纯化控制流**: 
   在 `SessionManager.chat()` 内部，不再手动操作 `history` 数组的增删改，而是：
   `const finalContext = this.contextAdapter.assemble(snapshotContext, transientSkillContent);`
3. **不可变原则 (Immutability)**:
   Adapter 必须保证返回的是一个深拷贝后的新数组快照，绝不允许在 `assemble` 过程中污染基线 `SessionContext` 的原有状态。

## 风险与权衡

- **上下文引用泄露风险**: 如果 Adapter 实现不当，直接修改了传入的 `baseHistory` 引用，会导致临时挂载的 `transient_skill` 成为永久记录，从而引发历史污染。
  - *缓解策略*: 在 `assemble` 方法内部强制执行数组展开或深拷贝 `[...baseHistory]`。
- **过度抽象风险**: 提前抽取 Adapter 可能增加微小的系统复杂度。
  - *缓解策略*: 在前期探索中对技术方案进行了对比，Adapter 模式有利于后续扩展支持缓存机制和上下文压缩。

## [Amend 修正] 针对关键安全隐患的架构修正决策

在方案审查中，识别并修正了原方案和已有系统的两个技术风险：

1. **防协议交错设计**：
   - **问题**：在 ReAct 的 `while` 多轮工具迭代中，直接对 `snapshotContext` 最后的元素进行弹出和插入会导致 `system` 消息插在 `assistant(tool_calls)` 与 `tool` 结果消息中间，可能导致大模型接口调用由于消息协议不合规而报错。
   - **设计修正**：适配器在实现 `assemble` 时，不能对尾部执行简单的弹出与插入。应通过 `findLastIndex` 找到最新一条 `user` 角色消息的位置，并将 `<transient_skill>` 注入该 `user` 消息之前。由于工具调用及其结果消息（`assistant` 和 `tool`）均在用户消息之后追加，该策略可保证 `assistant` 和 `tool` 消息相邻，从而避免协议错误。

2. **空 User 边界兜底**：
   - **问题**：在会话启动的首轮交互中，历史数据可能只包含 `system` 消息，不存在任何 `user` 消息，此时寻找 `user` 消息索引会返回 `-1`。
   - **设计修正**：适配器需检查 `user` 消息索引。若未检索到 `user` 消息（索引为 `-1`），则将包裹后的临时技能以 `system` 角色消息直接追加到消息数组的末尾进行兜底处理。
