## 1. 终端拦截器优化

- [x] 1.1 **自愈报错实现**： 在 `src/adapters/tools/impl/system/terminal.ts` 的 `checkSafety` 方法中，针对 `Plan` 模式下的拦截逻辑，在返回的错误 `message` 中动态拼接包含只读文件 `API` （ `list_dir` / `read_file` ）的自愈引导词。

- [x] 1.2 **单元测试校验**： 运行并校验现有 `test/adapters/tools/terminal.test.ts` 中的安全拦截测试是否与自愈提示报错相兼容，如果不兼容则调整相应断言。

<!-- checkpoint: npm run test -->


## 2. 工具下发与气泡策略

- [x] 2.1 **静态下发校验**： 检查 `agent-loop.ts` 或相关中间件在 `Plan` 模式下的工具过滤通道，确保工具集（包括 `execute_command` ）被完整且静态地发送给 `LLM` 接口，未被动态裁剪过滤。

- [x] 2.2 **提示气泡收紧**： 优化气泡提示词注入器中的规则描述，显式加强大模型调用只读原生文件工具高于通用终端工具的偏好，从上层压制终端依赖。

- [x] 2.3 **审计气泡留存**： 在 `agent-loop.ts` 气泡注入后，同步将气泡信息动态挂载至内存物理历史消息的最末条 User 消息的 `systemReminder` 属性上，支持序列化审计落盘。

- [x] 2.4 **全局测试运行**： 运行项目中所有集成测试，确保变更不破坏系统主干功能。

<!-- checkpoint: npm run test -->
