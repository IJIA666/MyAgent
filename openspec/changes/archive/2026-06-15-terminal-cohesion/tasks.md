## 1. 白名单与配置模块解耦 (Config & Whitelist Isolation)

- [x] 1.1 新建 `src/action/native-tools/terminal-config.ts` 文件，将安全模式 `WorkMode` 类型、全局状态、白名单文件的持久化存取与提取匹配规则（`loadAllowedCommands`、`saveAllowedCommands`、`loadWorkMode`、`saveWorkMode`、`getWorkMode`、`setWorkMode`、`extractSafePrefix`、`checkWhitelist`）迁移至该文件中。
- [x] 1.2 在 `src/config/loader.ts` 中适配引入并重构加载流程。

<!-- checkpoint: npm run build -->

## 2. 安全网关与人机交互解耦 (Security Gate & Interactive UI)

- [x] 2.1 新建 `src/action/native-tools/terminal-guard.ts` 文件，提取硬正则防拼接过滤以及工作区沙箱 cwd 边界校验。
- [x] 2.2 新建 `src/action/native-tools/terminal-interactive.ts` 文件，单独封装带有全局 Promise 串行化队列的控制台询问接口（`askUserPermission`），保证并发交互的安全和顺序。

<!-- checkpoint: npm run build -->

## 3. 核心进程执行引擎与门面装配 (Subprocess Engine & Facade Integration)

- [x] 3.1 新建 `src/action/native-tools/terminal-engine.ts` 文件，实现纯净无状态的进程 spawn 执行引擎底座（处理超时双定时器控制、Windows taskkill 进程树强杀、超大日志溢写与截断、Windows npm 重定向及 powershell 乱码防御）。
- [x] 3.2 清空原 `src/action/native-tools/terminal.ts` 文件的具体业务逻辑，改写为编排 4 个子模块的 Facade 门面入口。
- [x] 3.3 保持 [tools.ts](file:///D:/projects/MyAgent/src/action/tools.ts) 对 `executeCommandTool` 的直接导出路径不变，验证外部兼容性。

<!-- checkpoint: npm run build -->

## 4. 单元测试重组与全量验证 (Tests Refactor & Quality Assurance)

- [x] 4.1 修改 [terminal.test.ts](file:///D:/projects/MyAgent/test/action/terminal.test.ts) 单元测试文件，配合拆分后的子模块重整并丰富测试用例。
- [x] 4.2 运行项目的静态风格规约检查与全量功能回归测试，保障无任何问题。

<!-- checkpoint: npm run build && npm run test && npm run lint -->
