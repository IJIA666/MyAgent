## 1. 抽离与创建 Prompt Engine 骨架

- [x] 1.1 创建 `src/brain/prompts.ts` 模块
- [x] 1.2 将 `src/brain/session.ts` 中硬编码的 `systemPrompt` 完整剪切并存放至 `prompts.ts` 内部的常量中
- [x] 1.3 在 `prompts.ts` 中实现并导出 `buildSystemPrompt()` 纯函数

<!-- checkpoint: npx tsc --noEmit -->

## 2. 改造 SessionManager 切流

- [x] 2.1 修改 `src/brain/session.ts`，移除原有的硬编码模板
- [x] 2.2 在 `SessionManager` 的构造/初始化环节，调用 `buildSystemPrompt()` 挂载上下文

<!-- checkpoint: npx tsc --noEmit -->
