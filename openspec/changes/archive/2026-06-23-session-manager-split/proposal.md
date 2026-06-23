## 改造原因

当前系统中的会话管理器 `SessionManager` 直接承载了长期记忆管理（Memory Management）的具体实现逻辑。这包括物理文件的追加写入互斥队列、记忆要点切片（chunking）、调用 Embedding 服务、全量与增量同步向量数据库以及启动隔离的子智能体自省进行自提炼等。这些任务导致 `SessionManager` 体积庞大（近 800 行），违背了单一职责原则，增加了单元测试环境隔离和代码维护的难度，是一个典型的“上帝类”（God Class）。

为了解除这种不合理的紧密耦合，需要将所有与长期记忆管理相关的物理写入、自省计算和向量数据库同步等纯记忆相关的执行步骤，从会话管理器中完全抽离出来，下沉至新引入的独立的领域服务 `MemoryService` 中，从而实现系统模块的彻底解耦。

## 变更内容

1. **新建 `MemoryService` 领域服务**：负责处理长期记忆文件的物理写入（维持写队列）、记忆文本切片处理、分批调用向量生成接口以及同步并自动重建向量数据库。
2. **支持动态模型切换**：将 `triggerMemoryRefinementAsync` 提炼子智能体流程的方法签名修改为动态接收 `llmConfig` 传入，彻底消除构造注入，使后台自省子智能体的运行能完美追踪用户实时在 Cli 切换的大模型或采样参数。
3. **委托集成与简化**：
   - 简化 `SessionManager` 构造函数，在内部实例化并委托给 `MemoryService` 执行向量库重建。
   - 修改 `LongTermMemoryPlugin` 插件，将其触发自省记忆更新的回调委托给 `MemoryService` 的相应接口。
   - 彻底移除 `SessionManager` 内部近 340 行的长期记忆及子智能体相关的私有实现，使其只作为 ReAct 会话的核心编排引擎。
4. **排除检索逻辑（非目标）**：保留 `LongTermMemoryPlugin` 内部负责在 PreRunHook 阶段触发的记忆检索（RAG）逻辑，本次重构不对此做任何移动。

## 业务能力

### 新增业务能力
- 无

### 修改业务能力
- 无

## 影响范围

- **受影响的用例模块**：
  - `src/core/usecases/session.ts` (移除长期记忆管理等私有方法及相关成员)
  - `src/core/usecases/MemoryService.ts` [NEW] (新建并移入所有的长期记忆写入与自省逻辑)
- **受影响的单元测试**：
  - `test/session/SessionManager.test.ts` (对齐测试用例，保证测试用例兼容)
  - `test/session/MemoryService.test.ts` [NEW] (编写针对新服务的单元测试用例)
