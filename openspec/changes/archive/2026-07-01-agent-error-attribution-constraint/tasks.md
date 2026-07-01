## 1. 扩充提示词防御规约

- [x] 1.1 修改系统提示词文件 [prompts.ts](file:///d:/Projects/MyAgent/src/core/usecases/brain/prompts.ts)，在 `BASE_SYSTEM_PROMPT` 的第 9 条异常规避红线规则中新增未知报错分支三：若接收到的工具错误非网络超时、非 Schema 错配，则必须立即停止一切修改参数并重新调用的重试行为。模型必须如实向用户陈述错误原文、坦承无法判断根因并请求协同协助。

<!-- checkpoint: npm run lint -->

## 2. 工程稳定性与单测检验

- [x] 2.1 运行系统既有单元测试与集成测试，确保修改提示词后原有测试套件（包括 MCP 超时自愈重试单测）100% 顺利通过。

<!-- checkpoint: npm run test -->
