## 1. 定义适配器接口与核心实现

- [x] 1.1 创建 `src/brain/adapters/ContextAdapter.ts`，定义 `ContextAdapter` 接口，包含核心的 `assemble(baseHistory: ChatCompletionMessageParam[], transientContext?: string): ChatCompletionMessageParam[]` 方法。
- [x] 1.2 创建 `src/brain/adapters/DefaultContextAdapter.ts`，实现该接口，封装临时技能挂载逻辑。要求：
  - 严格使用深拷贝或展开运算符 `[...baseHistory]` 避免污染原始会话内存；
  - 动态检索最新一条 `user` 角色消息的位置进行插入，避免强行插入在 `assistant(tool_calls)` 与 `tool` 结果消息之间，防止模型接口报错；
  - 提供安全边界兜底，若 `baseHistory` 中无 `user` 消息，将包裹后的临时技能消息追加到末尾。
- [x] 1.3 在 `src/brain/adapters/index.ts` 中暴露相关接口与实现类。

<!-- checkpoint: npx tsc --noEmit -->

## 2. 重构主调度器

- [x] 2.1 修改 `src/brain/session.ts`，在 `SessionManager` 类中引入并实例化 `DefaultContextAdapter`（或支持外部注入）。
- [x] 2.2 移除 `chat()` 方法 `while` 循环内部硬编码的 `snapshotContext.push/pop` 逻辑。
- [x] 2.3 替换为调用适配器：`const snapshotContext = this.contextAdapter.assemble(this.context.getHistory(), transientSkillContent);`。
- [x] 2.4 清理冗余代码，确保 `LlmDriver.streamChat` 正确接收组装后的上下文快照。

<!-- checkpoint: npm run build -->
