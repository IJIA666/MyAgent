# 探索主题: 流式输出与深度思考展示 (Streaming & Reasoning UX)

## 1. 问题定义
当前 Agent（使用 `deepseek-v4-flash` 模型）通过同步阻塞模式（非流式）调用接口，导致响应有明显停顿且大段文字瞬间输出。同时，目前未在调用时传递启用思考能力的参数，导致终端界面缺乏对大模型“推理/思考”过程以及“工具调用”过程的细粒度过程展示，极大地影响了交互体验。

## 2. 关键发现与调研结果
- **现有逻辑**：在 `src/session.ts` 的 `107` 行附近，调用 `this.client.chat.completions.create` 时，未设置 `stream: true` 参数。
- **核心洞察（关于模型）**：纠正了之前的错误假设。`deepseek-v4-flash` 模型本身**具备原生思考能力**，无需使用 Prompt 强行让大模型打印 `<thought>` 标签，也无需切换到完全隔离的特定推理模型，只需要在调用 API 时**传入正确的控制参数**即可激活它的 Reasoning Track。

## 3. 方案推荐与架构路线

为了彻底解决终端交互体验问题，建议将该改造拆解为以下核心模块：

### A. 流式请求与响应流解析
修改 `session.ts` 中的调用：
```typescript
const stream = await this.client.chat.completions.create({
  model: this.modelName,
  messages: this.messageHistory,
  tools: allTools,
  stream: true,
  // 必须通过 extra_body 透传给 DeepSeek API，绕过 OpenAI SDK 的严格类型校验
  reasoning_effort: "high",
  // @ts-ignore
  extra_body: {
    thinking: { type: "enabled" }
  }
});
```
随后使用 `for await (const chunk of stream)` 消费数据流。在解析块时，区分 `chunk.choices[0].delta.reasoning_content`（思考内容）、`content`（最终回复）和 `tool_calls`（工具调用事件）。

### B. 终端 UI 渲染引擎 (CLI UX)
在 `index.ts`（或者独立的 `ui.ts` 模块）中引入或实现一套终端刷新机制：
- **思考中**：用灰色文本实时打印 `reasoning_content`。
- **工具调用**：捕捉流中的 `tool_calls` 碎片，将其聚合并以高亮或占位符形式（例如 `[⚡ 正在调用工具: tavily_search ...]`）实时显示。
- **正式回答**：用正常颜色打印 `content`。

## 4. 约束、风险与未知项
- **多轮对话的上下文连续性（强制要求）**：调研发现，当开启了思考模式且模型执行了工具调用时，在后续回合将 `messageHistory` 传回给大模型时，**必须**将上一轮返回的 `reasoning_content` 字段一并带上，否则会导致上下文断裂报错或思考连续性丢失。目前我们的 `session.ts` 只是简单地 push 了 `assistantMessage`，如果使用的是流式拼接，我们需要手动构造完整的 `Message` 对象并补齐 `reasoning_content` 字段。
- **参数排斥**：开启 `thinking` 模式后，标准的 `temperature`、`top_p` 等参数将失效，代码中需注意移除或忽略这些参数。
- **工具流式拼接逻辑（复杂）**：在流式输出中，`tool_calls` 的内容会被拆分成极细的 `delta` 碎片（如函数名碎片、参数 JSON 碎片）。我们需要在内存中建立一个缓冲拼接器，直到 `finish_reason` 触发或出现完整参数后，才能反序列化 JSON 并实际执行本地工具。这是本次改造的技术核心难点。
