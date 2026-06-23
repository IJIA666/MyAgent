## 1. 记忆领域服务声明与逻辑搬迁

- [x] 1.1 新建 `src/core/usecases/MemoryService.ts`，声明 `MemoryService` 类，搬入原 `SessionManager` 中与记忆文件写入、同步、重建向量库相关的核心逻辑与私有成员属性，并提供 TSDoc 注释。
- [x] 1.2 将记忆提炼自省方法 `triggerMemoryRefinementAsync` 与 `runMemoryRefinementSubAgent` 以及内部工具注册表类 `MemoryRefinementToolRegistry` 移入 `MemoryService.ts`，并重构方法签名，使其支持从外部接收动态实时的 `LlmConfig` 以确保适配动态模型切换。

<!-- checkpoint: npm run build -->

## 2. 会话管理器解耦集成与单测验证

- [x] 2.1 修改 `src/core/usecases/session.ts`，引入并实例化 `MemoryService`，将插件回调重定向至新服务并委托重建任务，彻底清空已搬迁的 340 余行记忆与子智能体逻辑（实现 SessionManager 瘦身）。
- [x] 2.2 新建单元测试 `test/session/MemoryService.test.ts`，对 `MemoryService` 的切片、向量同步及自省等关键链路编写单元测试进行全量覆盖。
- [x] 2.3 修复单元测试时序及反射路径问题：
  - [x] 2.3.1 修改 `src/core/usecases/MemoryService.ts`，在 `runMemoryRefinementSubAgent` 尾部消费完 `forkedAgent.chat` 生成器后，添加对物理异步写入队列的等待 `await this.writeQueue;`，确保自省子智能体提炼出的内容落盘和向量库重建已完全结束，解决单测异步竞态。
  - [x] 2.3.2 修改 `test/brain/plugins.test.ts`，将所有直接通过 `session` 实例对搬迁字段（如 `memoryFilePath`、`writeQueue`、`queueWrite`）的私有或强转反射访问，重定向为对 `session['memoryService']` 相应属性/方法的访问。
- [x] 2.4 运行项目编译、执行全量单元测试与 ESLint 代码规范检验，保证没有任何由于依赖解耦引入的错误或规范告警。

<!-- checkpoint: npm run build -->
<!-- checkpoint: npm run test -->
<!-- checkpoint: npm run lint -->

