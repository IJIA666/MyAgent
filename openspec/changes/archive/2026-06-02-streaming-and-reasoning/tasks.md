## 1. 升级大模型调用接口并开启流式参数

- [x] 1.1 修改 `src/session.ts`，在 `chat.completions.create` 请求中添加 `stream: true` 参数
- [x] 1.2 在请求参数中通过 `extra_body: { thinking: { type: "enabled" } }` 与 `reasoning_effort: "high"` 激活 `deepseek-v4-flash` 的深度思考模式（需使用 `@ts-ignore` 规避 `openai` 强类型校验）
- [x] 1.3 移除可能与 thinking 模式冲突的常规控制参数（如 `temperature` 或确保它们不被设置）

## 2. 核心：实现流式碎片处理与本地状态机

- [x] 2.1 重写 `session.ts` 中的响应接收逻辑，改用 `for await (const chunk of stream)` 进行流式读取
- [x] 2.2 建立临时缓冲变量：`fullContent`、`fullReasoning` 以及 `accumulatedToolCalls`
- [x] 2.3 分支解析逻辑 - 思考：拦截 `chunk.choices[0].delta.reasoning_content`，用灰色 ANSI 颜色通过 `process.stdout.write` 实时打印
- [x] 2.4 分支解析逻辑 - 回复：拦截 `chunk.choices[0].delta.content`，正常打印并累加至 `fullContent`
- [x] 2.5 分支解析逻辑 - 工具碎片：拦截 `chunk.choices[0].delta.tool_calls`，按 `index` 动态向 `accumulatedToolCalls` 聚合 `name` 和 `arguments`

## 3. 增强终端 UI 渲染与反馈体验

- [x] 3.1 引入 ANSI 转义序列常量（如灰色 `\x1b[90m`，青色 `\x1b[36m`，重置 `\x1b[0m` 等）
- [x] 3.2 优化原有的单行纯文本提示，当 `stream` 结束并开始正式调用工具时，以高亮闪电图标 `[⚡ 正在调用本地工具 "<工具名>"]` 格式打印
- [x] 3.3 优化报错输出（如 JSON 解析失败、调用异常等），确保其在流式输出被打断时能显眼地呈现在新行

## 4. 重建与维护上下文完整性

- [x] 4.1 确保单轮响应流结束后，手动拼装并压入符合 OpenAI 协议的 `ChatCompletionAssistantMessageParam`
- [x] 4.2 严格检查并确保拼装的 `message` 带有刚刚获取到的 `reasoning_content`（需使用 `any` 或扩展类型绕过原始接口限制）
- [x] 4.3 同样确保 `message.tool_calls` 被正确绑定，随后正常分发调用本地工具并把工具结果发回给大模型进行下一轮回话

## 5. 验证与回归测试

- [x] 5.1 本地提问通用问题，观察终端是否呈现出灰色的流式思考过程，以及正常的最终回答
- [x] 5.2 提问包含明确功能调用的需求（如“搜索一下今天天气”），观察工具调用期间是否出现 ⚡ 高亮提示，且参数传递是否正确，结果处理是否正常无报错。

## 6. 参数化解耦与多模型配置扩展 [Amend 追加]

- [x] 6.1 在 `config.ts` 抽象出 `ModelProfile` 接口，构建 `BUILTIN_MODELS` 预设池，并提供基于环境变量的 `buildExtraPayload` 钩子函数
- [x] 6.2 扩展 `.env` 和 `LlmConfig` 接口，支持配置 `DEEPSEEK_MAX_TOKENS` 与 `DEEPSEEK_REASONING_EFFORT` 
- [x] 6.3 替换 `session.ts` 请求体中的 `max_tokens` 与 `extra_body` 硬编码，改由读取全局配置，实现对“彻底关闭思考功能 (disabled)”的良好支持

## 7. 强制语言与行为边界规范 [Amend 追加]

- [x] 7.1 在 `session.ts` 的 `systemPrompt` 中，注入一条 `【语言强制】` 原则，约束模型在 reasoning_content 输出阶段必须维持使用简体中文，防止语种退化。
