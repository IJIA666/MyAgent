## 背景

当前 `MyAgent` 项目启动时，直接从 `.env` 中读取模型名称和 API Key（例如 `DEEPSEEK_MODEL`、`DEEPSEEK_API_KEY`），并在 `SessionManager` 中固化了发起请求的 payload。这种强耦合导致系统在使用不同的模型时，无法对特殊的请求载荷（如特定于 deepseek-reasoner 的 reasoning_effort 字段）做出灵活适配。用户希望能够在会话交互中，通过 `/model <id>` 的命令无缝地更换模型，并加载对应模型的环境凭证和适配载荷，而无需重启应用。

## 目标与非目标

**目标:**
- 支持内置多款预设的主流模型配置（DeepSeek 及其它主流模型）。
- 在交互界面中截获 `/model` 命令，实现模型的动态且安全的热切换。
- 在 `SessionManager` 中分离出模型特定的 payload 生成逻辑。
- 保证用户在未配置某模型 API Key 时能够得到优雅的提示，而不是崩溃。

**非目标:**
- 暂不支持用户在不修改代码的情况下，通过配置文件自行添加新的自定义外部模型（未来可扩展，当前仅支持内置列表）。
- 不触及历史会话上下文的消息格式转换（假定历史的 messages 列表跨大模型通用）。

## 架构决策

- **引入 `ModelProfile` 接口和预置列表**：在 `config.ts` 或新建立的 `models.ts` 中维护一个内置的模型配置字典，记录模型 id、API Base URL 环境变量名、API Key 环境变量名，以及特有 payload 函数（例如，针对 DeepSeek-R1 生成 `extra_body`）。
- **[Amend 修正] 独立的 CommandRouter 模块**：为了防止 `index.ts` 随着指令增加而膨胀，剥离出独立的 `src/command.ts`，定义 `dispatchCommand(input, context)`，通过策略模式或简单的映射表注册并分发所有前缀为 `/` 的系统命令。
- **拦截 Slash Command 的时机**：在 `index.ts` 中监听 `readline` 的 `line` 事件，识别如果是以 `/` 开头，则将其视为命令拦截，委派给 `CommandRouter` 执行，不放入 `SessionManager` 的会话流中。对于 `/model <id>` 命令，查找到对于预置对象后，重新创建或调整 `SessionManager` 内的 client 与模型绑定。
- **动态凭据校验**：当切换到目标模型时，检查对应的 `process.env[API_KEY_NAME]`。如果不存在，阻断切换并提示用户：“请在 .env 中补充 xxx 的 API Key”。

## 风险与权衡

- [Risk] 会话中途切换到能力较弱的模型可能导致先前的上下文超出 token 限制，或者难以理解先前的复杂约束。 → Mitigation: 这是用户自主发起的降级，系统不负责强制拦截，但后续交互响应如有异常应优雅抛出。
- [Risk] `SessionManager` 的强耦合设计需要在热切换时重新初始化其内部的 `OpenAI` 客户端。 → Mitigation: 提供一个 `switchModel(profile)` 方法，能够重用 `messageHistory` 的同时新建 `OpenAI` 客户端实例。
