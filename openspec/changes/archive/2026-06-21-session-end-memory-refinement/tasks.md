## 1. 记忆管理核心逻辑与文件接口实现

- [x] 1.1 编写 `LongTermMemoryPlugin.ts` 插件基础骨架，继承 `Plugin` 接口，定义 `name` 为 `'LongTermMemoryPlugin'` 且设置适当的 `weight` 优先级。
- [x] 1.2 编写 `LongTermMemoryPlugin` 构造函数，支持接收 `LlmPort` 作为模型驱动接口。
- [x] 1.3 编写 `MEMORY.md` 读写文件工具，在插件中利用 Node.js `fs` 的 `promises` 提供增量追加事实和限制最大读取长度（最新 4000 字符）加载内容的方法。

<!-- checkpoint: npm run build -->

## 2. BeforeModel 长期记忆召回注入

- [x] 2.1 在 `LongTermMemoryPlugin` 的 `HookEventName.BeforeModel` 中，读取 `MEMORY.md` 记忆文件（最大限制读取最新 4000 字符）。
- [x] 2.2 若记忆文件存在且非空，在 `context.llmRequest.messages` 中寻找第一个 `role === 'system'` 的消息并将记忆追加到其 `content` 末尾；如果未找到，则在数组首部新插入一个 system 消息。

<!-- checkpoint: npm run build -->

## 3. SessionEnd 异步自省提炼

- [x] 3.1 在 `LongTermMemoryPlugin` 的 `HookEventName.SessionEnd` 钩子中，获取最近的会话消息历史，增加前置安全校验逻辑：若消息历史中对话总数少于 2 轮则直接优雅返回，不触发后续提炼。
- [x] 3.2 实现异步脱钩调度，使用 `Promise.resolve().then(...)` 或 `setTimeout` 在后台（非阻塞主线程）启动提炼任务。
- [x] 3.3 提炼任务调用 `LlmPort.chat`（或 `streamChat` ）驱动 LLM 对话自省，并将提炼出的格式化事实增量追加写入根目录下 `MEMORY.md` 。

<!-- checkpoint: npm run build -->

## 4. 插件注册与集成验证

- [x] 4.1 在 `src/core/usecases/session.ts` 构造函数中实例化并注册 `LongTermMemoryPlugin`，传入模型驱动器 `this.driver`。
- [x] 4.2 编写单元测试用例，覆盖 `LongTermMemoryPlugin` 在 `BeforeModel` 注入记忆、`SessionEnd` 过滤拦截与异步提炼并追加写入文件的全流程逻辑，确保编译和单测完全通过。

<!-- checkpoint: npm test -->
