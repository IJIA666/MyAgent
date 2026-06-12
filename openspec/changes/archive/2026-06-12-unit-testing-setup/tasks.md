## 1. 单元测试环境搭建与配置

- [x] 1.1 使用 npm 安装测试驱动包 `vitest` 及其依赖，加入到 `devDependencies` 中。
- [x] 1.2 在项目根目录下创建配置文件 `vitest.config.ts`，配置测试文件查找目录 `test/**/*.test.ts` 并完成 ESM 环境支持。
- [x] 1.3 在 `package.json` 中的 `scripts` 下面添加 `"test": "vitest run"` 执行脚本。

<!-- checkpoint: npm run build -->

## 2. 安全沙箱单元测试实施

- [x] 2.1 在项目中创建 `test/action/tools.test.ts` 测试文件，导入 `secureResolvePath`。
- [x] 2.2 编写针对正常路径解析的断言，确保工作区内的直接子文件/目录读写功能不受损。
- [x] 2.3 编写针对路径越界遍历攻击（恶意传入外层相对路径如 `../../etc/passwd` 以及物理绝对路径如 `C:\Windows`）的阻断拦截断言。
- [x] 2.4 编写针对同前缀目录逃逸攻击（如授权目录为 `/auth/path`，试图访问 `/auth/path-secret`）的精细化阻断断言。

<!-- checkpoint: npx vitest run test/action/tools.test.ts -->

## 3. MCP 客户端与同名冲突单元测试实施

- [x] 3.1 在项目中创建 `test/action/mcp-client.test.ts` 测试文件。
- [x] 3.2 借助 `@modelcontextprotocol/sdk` 中的 `InMemoryTransport` 并在内存中建立模拟的 Mock MCP 客户端与服务端通信流。
- [x] 3.3 编写针对外部工具重名注册的冲突测试，断言 `getMcpTools` 在遭遇同名冲突时是否能如期抛出 Error 并强阻断启动。
- [x] 3.4 编写优雅注销序列测试，监听并断言 `close()` 在触发 `transport.close` 之后、异步缓冲 3 秒优雅等待、继而触发 `client.close` 的链路执行时序。
- [x] 3.5 编写信号注销测试，断言在测试套件执行完毕并关闭连接后，宿主进程挂载的全局信号监听器（SIGINT/SIGTERM/exit）已被 `process.off` 彻底移除。

<!-- checkpoint: npx vitest run test/action/mcp-client.test.ts -->

## 4. 上下文适配器单元测试实施

- [x] 4.1 在项目中创建 `test/brain/adapters/DefaultContextAdapter.test.ts` 测试文件，引入 `DefaultContextAdapter`。
- [x] 4.2 编写针对“无注入内容时原样返回”的测试用例，断言组装后的历史消息队列与原快照完全全等。
- [x] 4.3 编写针对“局部规则与临时技能正确注入”的测试用例，验证注入内容被正确的 XML 标签包裹（`<project_rules>` 在前，`<transient_skill>` 在后），并且精准插入到最后一条 `user` 角色消息的前面。
- [x] 4.4 编写针对“空消息历史或无 user 角色消息”的边界测试，验证注入内容安全地追加到整个消息数组的最尾端以进行容错保护。

<!-- checkpoint: npm run test -->
