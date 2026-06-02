## 架构目标

1. 在终端上实现平滑的流式响应输出，降低用户等待焦虑。
2. 以细粒度的 UI（例如灰字、特殊符号）实时展示模型深度思考（Reasoning）的中间过程。
3. 可视化模型发起工具调用（Tool Calling）的过程，而不是一个突兀的等待黑盒。
4. 确保在包含工具调用的多轮循环对话中，严格遵守官方协议将思考内容重新发还给模型，维持思考链的连贯性。

## 技术选型与决策

### 决策 1：流式 API 接入与参数透传

**方案**：在 `this.client.chat.completions.create` 中设置 `stream: true`。同时，为激活 DeepSeek-V4-Flash 的思考能力，使用 OpenAI Node SDK 提供的扩展能力，通过 `extra_body` 参数直接注入自定义字段，绕过 SDK 强类型校验。

*【Amend 修正】*：早先的硬编码方案在多模型扩展中显得脆弱。现在改为在 `config.ts` 中抽象出 `ModelProfile` 接口和 `BUILTIN_MODELS` 映射表，通过 `buildExtraPayload` 钩子动态读取 `DEEPSEEK_REASONING_EFFORT`。若该变量为 `disabled` 则直接返回空对象以切断附加参数注入，彻底解除 `session.ts` 与模型独占参数的硬耦合。同时将 `max_tokens` 同步抽离。

### 决策 2：流式状态机与解析器

**背景**：在开启流式（Streaming）后，`openai` SDK 返回的是一个个数据块（chunk）。其中：
- 思考过程在 `chunk.choices[0].delta.reasoning_content`。
- 回复内容在 `chunk.choices[0].delta.content`。
- 工具调用在 `chunk.choices[0].delta.tool_calls`。由于工具参数是 JSON，流式返回时会被切分成无数小段（如 `"{"`，`"query"`，`":"`，`"xx"}`）。

**方案**：
引入局部状态机，在每次读取 chunk 时：
1. 若有 `reasoning_content`，则使用 `process.stdout.write` 输出带颜色（如灰色）的文本。
2. 若有 `content`，则使用 `process.stdout.write` 输出最终回复。
3. 若有 `tool_calls`，则在内存中维护一个数组结构 `accumulatedToolCalls`，根据 `toolCall.index` 动态拼接函数名（`name`）和参数（`arguments`）。
4. 直到当前数据流结束（或遇到 `finish_reason === 'tool_calls'`），此时内存中的 JSON 参数拼接完整，开始进行 `JSON.parse` 并实际执行本地工具。

### 决策 3：上下文拼装与思考链追踪

**背景**：流式返回不像单次调用那样直接提供一个完整的 `message` 对象。我们需要自己拼装出一个完整的、符合 OpenAI 协议的 `ChatCompletionAssistantMessageParam` 来压入 `messageHistory`。更为关键的是，根据官方文档，如果存在思考过程，多轮调用时必须包含该字段。

**方案**：
在流式读取开始前，声明缓冲变量：
```typescript
let fullContent = '';
let fullReasoning = '';
// accumulatedToolCalls = []
```
流式读取结束后，构造符合标准的助理消息：
```typescript
const assistantMessage: any = {
  role: 'assistant',
  content: fullContent || null,
};
if (fullReasoning) {
  assistantMessage.reasoning_content = fullReasoning;
}
if (accumulatedToolCalls.length > 0) {
  assistantMessage.tool_calls = accumulatedToolCalls;
}
this.messageHistory.push(assistantMessage);
```
*(注意此处需要绕过 `ChatCompletionAssistantMessageParam` 中可能缺失的 `reasoning_content` 字段类型定义)。*

### 决策 4：终端 UI 样式控制

**方案**：
引入 ANSI 转义码来控制颜色：
- 思考中：`\x1b[90m`（亮灰）
- 工具调用提示：`\x1b[36m`（青色）+ 闪电符号 ⚡
- 正常回复：`\x1b[0m`（重置颜色）
UI 的输出直接散落在 `session.ts` 的解析循环中，采用 `process.stdout.write` 以支持不换行输出。

### 决策 5：系统提示词（System Prompt）注入防语言降级 *【Amend 追加】*

**背景**：自带原生 CoT (Chain-of-Thought) 能力的大模型，在遇到复杂的英文名词时往往会自动回落至使用英文推理。
**方案**：修改 `session.ts`，在原有的三条安全边界指令后方追加第 4 条“语言强制”指令，直接规范大模型将整个推演逻辑和最终反馈牢牢锚定在简体中文，以消除外语推理造成的心智落差。
