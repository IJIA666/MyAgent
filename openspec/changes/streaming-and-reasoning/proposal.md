## 改造原因

当前的 Agent 会话机制（`session.ts`）使用了阻塞式的全量响应模式，大模型需要完全生成完结果后才会一次性输出到终端，导致响应存在明显的停顿感。同时，目前未能在终端中细粒度地展示大模型的推理思考过程（Reasoning）与工具调用过程（Tool Calls），导致交互体验缺乏透明度和实时性。

## 变更内容

- 修改 `session.ts` 中 `chat.completions.create` 的调用方式，开启 `stream: true` 以支持流式返回。
- 引入 `deepseek-v4-flash` 模型的深度思考能力配置，通过 `extra_body` 透传 `thinking: { type: "enabled" }` 等控制参数。
- 在 `session.ts` 中实现流式分块解析器，能够实时提取并隔离 `reasoning_content`（思考内容）、`content`（正式回复）和 `tool_calls`（工具调用参数）。
- 在多轮工具调用时，按官方规范修复 `messageHistory` 的拼装机制，强制带上上一轮的 `reasoning_content` 字段。
- 优化终端打印机制：用灰色字体实时打印思考过程，用高亮格式实时展示工具调用事件，并用正常格式输出最终对话。

## 业务能力

### 修改业务能力
- `simple-agent-core`: 交互式命令行 REPL 循环。原先的阻塞交互模式将被替换为具备流式文字输出、深度思考展示、工具调用实时提醒的进阶交互模式。

## 影响范围

- **代码文件**：主要修改 `src/session.ts`，可能会提取部分 UI 打印逻辑到 `src/index.ts` 或独立的 `ui.ts`。
- **外部接口**：大模型 API 调用由同步变为异步数据流遍历（async iterable）。
- **向后兼容**：不涉及持久化数据格式变更，仅针对终端输出，无兼容性包袱。
