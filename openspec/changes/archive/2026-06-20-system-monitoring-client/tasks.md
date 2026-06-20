## 1. 客户端集成配置与自动拉起

- [x] 1.1 在配置文件 `mcp_config.json` 中为 `windows-monitoring` 服务端注册 stdio 连接参数，指定命令为 `uv`，参数为 `["--directory", "monitoring_server", "run", "python", "main.py"]` 并设置 `enabled` 为 `true`
- [x] 1.2 在 `src/action/mcp-client.ts` 的 `connectSingle` 实例化 StdioClientTransport 时，显式传递 `stderr: "pipe"` 配置以开启 Stdio 错误流劫持

<!-- checkpoint: npm run build -->

## 2. 错误流特征拦截与优雅降级

- [x] 2.1 修改 `src/action/mcp-client.ts` 的 `connectSingle`，使用监听器在 `transport.stderr` 上动态累加日志流
- [x] 2.2 在 `connectSingle` 的异常捕获块中，对捕获到的错误日志进行匹配校验；若错误中含有 "requires Administrator privileges" 关键字，则向主控台打印高亮的红色警告信息指导用户进行特权提升，且正常阻断该服务的进一步异常抛出，保障客户端正常降级加载

<!-- checkpoint: npm run build -->

## 3. 全局静态分析与编译测试

- [x] 3.1 运行 TypeScript 编译器，确保对于基础 `Stream` 类型的 `transport.stderr` 合理向下转型为 `Readable` 以安全绑定数据事件，坚决不使用任何 `as any`，保证全量代码类型安全无编译错误
- [x] 3.2 运行客户端既有单元测试，保证未对既有连接和其他 MCP 组件带来任何回归性 Bug

<!-- checkpoint: npm run test -->
