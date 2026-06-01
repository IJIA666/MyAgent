## 1. 基础配置与注册表结构

- [x] 1.1 在 `src/config.ts` 中定义 `ModelProfile` 接口（包含 id, API Key 变量名, Base URL 等属性）。
- [x] 1.2 在 `src/config.ts` 中建立内置的 `BUILTIN_MODELS` 映射表，录入 deepseek、gpt-4o、claude-3.5 等常见模型。
- [x] 1.3 调整 `loadConfig()` 中的必填校验，根据设定的默认模型仅要求默认模型凭证。

<!-- checkpoint: npx tsc --noEmit -->

## 2. SessionManager 的解耦重构

- [x] 2.1 修改 `SessionManager` 的构造函数，使其接受完整的 `ModelProfile`，不再硬编码 deepseek 属性。
- [x] 2.2 在 `session.ts` 的 `chat` 方法中，移除原硬编码的 `reasoning_effort` 与 `thinking`，改为根据传入的 `ModelProfile` 动态展开附加 Payload 参数。
- [x] 2.3 在 `SessionManager` 中新增 `switchModel(profile: ModelProfile)` 方法，支持复用 `messageHistory` 的同时重新初始化底层 OpenAI Client。

<!-- checkpoint: npx tsc --noEmit -->

## 3. Slash Command 拦截与调度

- [x] 3.1 在 `src/index.ts` 的 `readline` 回调中，增加对首字符为 `/` 的拦截分支。
- [x] 3.2 实现对 `/model <id>` 的解析逻辑，并匹配 `BUILTIN_MODELS`。
- [x] 3.3 如果找不到对应模型或对应模型未配置 API Key，在终端输出红色错误提示。
- [x] 3.4 正常匹配后，调用 `session.switchModel` 更新引擎上下文，并输出绿色成功提示。

<!-- checkpoint: npm run lint -->

## 4. [Amend] Slash Command 路由解耦

- [x] 4.1 新建 `src/command.ts`，定义 `CommandContext` 接口（包含 session, rl 等上下文）和 `dispatchCommand` 函数。
- [x] 4.2 将 `index.ts` 中针对 `/model` 的 `if-else` 解析逻辑平移到 `command.ts` 中的 `handleModelCommand` 独立函数。
- [x] 4.3 在 `command.ts` 中添加对未知命令以及占位符命令（如 `/help`）的基础提示。
- [x] 4.4 修改 `src/index.ts`，引入并调用 `dispatchCommand`，清理残留的命令解析硬编码。

<!-- checkpoint: npx tsc --noEmit && npm run lint -->
