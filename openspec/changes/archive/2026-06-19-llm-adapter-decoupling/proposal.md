## 改造原因

目前智能体的大语言模型（LLM）驱动在架构设计和目录组织上存在以下边界污染痛点：
1. **跨层双向强耦合**：大模型驱动 [driver.ts](file:///d:/Projects/MyAgent/src/brain/driver.ts) 和 Token 估算器 [TokenEstimator.ts](file:///d:/Projects/MyAgent/src/brain/TokenEstimator.ts) 存放在核心领域层 `src/brain/` 下，且在编译期直接依赖了 `openai` SDK 以及 `js-tiktoken` 分词库，严重违背了“Domain 核心应保持纯粹且不直接依赖外部基础设施与第三方库”的六边形架构原则。
2. **缺乏 Port 抽象契约**：大脑核心大循环 [agent-loop.ts](file:///d:/Projects/MyAgent/src/brain/agent-loop.ts) 直接静态 `import` 并调用了具体的 `LlmDriver` 实现，限制了向 Gemini、DeepSeek 等其它大模型厂商 Native 协议的扩展能力。
3. **视觉与文件污染**：硬编码的提示词模板模块 [prompts.ts](file:///d:/Projects/MyAgent/src/brain/prompts.ts) 平铺在 `src/brain/` 根目录，导致大脑空间缺乏物理内聚。

## 变更内容

1. **接口契约抽象 (Ports)**：
   在 `src/brain/ports/` 下定义统一的 `LlmPort`（大模型异步流式交互与同步交互）与 `TokenEstimatorPort`（Token 计算与水位拦截）接口规范。剥离消息类型对 `openai` SDK 的强引用，改用领域层自决的 TS 类型。
2. **物理基础设施下沉 (Adapters)**：
   将具体的 `LlmDriver` 重构为 `OpenAiLlmAdapter`，并将 `TokenEstimator` 重构为 `TiktokenEstimator`，同时移出核心领域层，下沉至顶级物理基础设施目录 `src/infrastructure/llm/` 中，实现对应的 Port 契约。
3. **提示词物理内聚**：
   将硬编码提示词模板模块 [prompts.ts](file:///d:/Projects/MyAgent/src/brain/prompts.ts) 移动至 `src/brain/prompts/` 专属子目录下实现物理内聚，净化大脑皮层空间。
4. **控制反转与依赖注入 (IoC/DI)**：
   修改大脑核心推理循环 [agent-loop.ts](file:///d:/Projects/MyAgent/src/brain/agent-loop.ts) 与 `Session`，使其仅通过构造函数依赖抽象的 `LlmPort` 与 `TokenEstimatorPort`。在系统初始化入口 `src/index.ts` 中装配外围的 `OpenAiLlmAdapter` 与 `TiktokenEstimator` 并注入大脑，实现依赖方向反转。

## 业务能力

### 新增业务能力
- `llm-adapter`: 统一的大模型与 Token 物理计算基础设施适配契约规范，大脑皮层去污染，且能即插即用切换不同的模型服务。

## 影响范围

1. **src/brain/**：[driver.ts](file:///d:/Projects/MyAgent/src/brain/driver.ts) 和 [TokenEstimator.ts](file:///d:/Projects/MyAgent/src/brain/TokenEstimator.ts) 将不再存放在此目录下。[prompts.ts](file:///d:/Projects/MyAgent/src/brain/prompts.ts) 将物理移动。新增抽象契约接口。
2. **src/infrastructure/llm/**：新增顶级目录，容纳具体依赖 `openai` 和 `js-tiktoken` 的外部适配器。
3. **src/brain/agent-loop.ts** & **session.ts**：重构构造器参数，从直接 import 改为面向 Port 接口编程与动态注入。
4. **单元测试与集成测试**：修复涉及这些类的测试代码导入路径与 Mock 策略。
