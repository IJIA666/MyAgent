## 1. 基础设施与环境初始化

- [x] 1.1 创建工作区下的核心配置文件，包括 `package.json`（设定 `"type": "module"` 引入 ESM 模块支持）、`.gitignore`（将 `.env` 排除在版本控制外）以及 `.env.example` 环境变量配置模板。
- [x] 1.2 创建符合现代 ESM 规范的 `tsconfig.json` 编译器配置文件。
- [x] 1.3 利用 npm/pnpm 安装核心依赖包 `openai`、`dotenv`，并安装开发依赖包 `typescript`、`tsx`、`@types/node`。

<!-- checkpoint: npx tsc --noEmit -->

## 2. 具有物理路径沙箱的安全文件操作 Tools 开发

- [x] 2.1 编写 `src/tools.ts` 文件，声明并导出大模型兼容的 `tools`（类型为 `type: "function"`）参数配置声明 JSON。
- [x] 2.2 实现 `readFile`（读取文件）、`writeFile`（写入文件）、`listFiles`（列出文件）三大工具的本地 Node.js 业务逻辑。
- [x] 2.3 在各文件操作工具的入口引入绝对路径沙箱防卫逻辑：应用 `path.resolve` 与 `process.cwd()` 锁定授权工作区根目录，若检测到大模型传入的目标路径溢出当前授权路径边界，强制阻断操作并返回 “Access Denied: Path is outside the authorized directory” 错误。

<!-- checkpoint: npx tsc --noEmit -->

## 3. 大模型会话管理器开发 (LLM Session Manager)

- [x] 3.1 编写 `src/session.ts`，基于 `dotenv` 环境配置加载 API Key 与动态指定的 DeepSeek 模型名称。
- [x] 3.2 实现内存级会话消息队列，自动处理上下文追加并注入系统提示词（System Prompt）。
- [x] 3.3 实现 Tools 工具执行的异步路由与大模型响应的重试判定：捕捉响应中的 `tool_calls`，路由到对应的沙箱文件操作工具执行，并将结果以 `role: "tool"` 反馈回消息历史，递归调用直至获得自然语言文本回复。

<!-- checkpoint: npx tsc --noEmit -->

## 4. 控制台 REPL 交互界面开发与全局集成测试

- [x] 4.1 编写 `src/index.ts` 作为应用主入口，利用 Node.js `readline` 模块创建控制台交互式命令行 REPL 循环。
- [x] 4.2 在 REPL 交互中设计高辨识度的终端状态回显，精细输出 Agent 的动作状态（如显示思考中、显示正在读取/写入哪一个文件的状态）。
- [x] 4.3 准备本地测试用的 `.env` 配置文件，启动 Agent 并进行完整的多轮对话和文件操作（如“帮我列出当前目录”、“创建一个 hello.txt 文件，并写入 hello word”）的集成闭环测试。

<!-- checkpoint: npx tsc --noEmit -->
