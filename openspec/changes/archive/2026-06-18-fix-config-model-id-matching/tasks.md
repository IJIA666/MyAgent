## 1. 修正配置预加载与控制台展示

- [x] 1.1 修改 `src/config/loader.ts`，在解析环境变量 `DEEPSEEK_MODEL` 确定 `defaultModelId` 时，增加正则 `.replace(/\[\d+[km]\]/i, '')` 以自动剥离类似 `[1m]` 或 `[128k]` 的窗口限制后缀。
- [x] 1.2 修改 `src/index.ts` 中的启动 Banner 打印逻辑，在配置摘要面板中追加输出格式化的 `llm.contextWindow` 上下文总限制。
- [x] 1.3 修改 `src/brain/session.ts` 中的 `getModelName()` 函数，根据 `llmConfig.contextWindow` 的值动态换算并在模型名称后拼接对应的窗口后缀标签（如 `[1m]`），以刷新 REPL 的提示符界面。

<!-- checkpoint: npm run build -->

## 2. 验证程序运行与测试

- [x] 2.1 本地执行 `npm run dev` 启动 Agent，验证在普通控制台下系统不再由于模型 ID 匹配崩溃，且能顺利打印出带有上下文限制总结的欢迎 Banner。
- [x] 2.2 验证在 REPL 命令行中，输入提示符能够动态显示为携带窗口大小后缀的格式，如 `用户 [deepseek-v4-flash[1m]] >`。
- [x] 2.3 本地执行单元测试，保证所做更改没有对既有系统行为产生副作用。

<!-- checkpoint: npm run test -->
