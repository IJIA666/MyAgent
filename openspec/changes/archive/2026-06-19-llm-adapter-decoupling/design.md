## 背景

智能体大脑 `src/brain/` 根目录被直接强耦合了 `openai` SDK、具体厂商 API 类型以及本地分词库 `js-tiktoken`，这在物理文件和逻辑设计上均构成了对 Domain Core 的污染，违背了六边形架构中“域核心仅依赖抽象 Ports，而 Adapters 依赖 Ports”的基本物理与编译期边界护栏。

## 目标与非目标

**目标**：
1. **接口契约（Ports）隔离**：在大脑 Domain 层定义 `LlmPort` 与 `TokenEstimatorPort` 抽象契约。
2. **外部组件基础设施化（Adapters）**：将依赖特定第三方库的实现类（`OpenAiLlmAdapter`、`TiktokenEstimator`）物理下沉到顶层独立基础设施层 `src/infrastructure/llm/` 目录下。
3. **视觉净化与内聚**：将硬编码提示词模板文件 `prompts.ts` 物理移动到 `src/brain/prompts/` 目录下隔离。
4. **控制反转（IoC）**：大脑大循环 `agent-loop.ts` 与 `Session` 的外部依赖全部改为通过构造器（Constructor）注入，实现依赖方向反转。

**非目标**：
1. 不更改大模型请求本身的超时、流式返回等业务逻辑。
2. 不修改外围的 `HumanApprovalPlugin` 审批插件，其继续保持无状态卡关行为。
3. 不添加多模型驱动的运行时热插拔业务逻辑（本次重构仅做架构解耦，不引入额外多模型配置特性）。

## 架构设计与重构细节

### 1. 领域层 Port 契约设计

#### [NEW] [LlmPort.ts](file:///d:/Projects/MyAgent/src/brain/ports/LlmPort.ts)
定义不依赖外部 SDK 的核心大模型交互契约：
```typescript
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_call_id?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

export type LlmStreamEvent =
  | { type: 'thinking'; content: string }
  | { type: 'content'; content: string }
  | { type: 'tool_calls'; toolCalls: any[]; assistantMessage: ChatMessage; usage?: any }
  | { type: 'complete'; content: string; reasoning: string; assistantMessage: ChatMessage; usage?: any };

export interface LlmPort {
  getModelName(): string;
  switchModel(newConfig: any, options?: Record<string, unknown>): void;
  abort(): void;
  streamChat(messages: ChatMessage[], tools: any[]): AsyncGenerator<LlmStreamEvent, void, unknown>;
  chat(messages: ChatMessage[]): Promise<string>;
  generateSummaryAsync(messages: ChatMessage[]): Promise<string>;
}
```

#### [NEW] [TokenEstimatorPort.ts](file:///d:/Projects/MyAgent/src/brain/ports/TokenEstimatorPort.ts)
定义 Token 计算与水位决策契约：
```typescript
export interface TokenEstimatorPort {
  countTokens(text: string): number;
  estimateMessageTokens(message: ChatMessage): number;
  estimateSnapshotTokens(
    snapshotContext: ChatMessage[],
    lastApiUsage: any,
    lastApiHistoryLength: number
  ): any;
  getCompactionThreshold(config: any, ratio?: number): number;
}
```

### 2. 基础设施层 Adapter 设计

#### [NEW] [OpenAiLlmAdapter.ts](file:///d:/Projects/MyAgent/src/infrastructure/llm/OpenAiLlmAdapter.ts)
将原 [driver.ts](file:///d:/Projects/MyAgent/src/brain/driver.ts) 移入此处，重命名为 `OpenAiLlmAdapter` 并实现 `LlmPort` 接口，内聚 `OpenAI` 官方 SDK 的所有网络请求与流式 chunk 处理逻辑。

#### [NEW] [TiktokenEstimator.ts](file:///d:/Projects/MyAgent/src/infrastructure/llm/TiktokenEstimator.ts)
将原 [TokenEstimator.ts](file:///d:/Projects/MyAgent/src/brain/TokenEstimator.ts) 移入此处，重命名为 `TiktokenEstimator` 并实现 `TokenEstimatorPort`，内聚 `js-tiktoken` 本地编码长度预估的所有分词底层细节。

### 3. prompts.ts 物理重组

将 [prompts.ts](file:///d:/Projects/MyAgent/src/brain/prompts.ts) 物理移动到 [src/brain/prompts/prompts.ts](file:///d:/Projects/MyAgent/src/brain/prompts/prompts.ts)，并重构其中的类型引用，将 `ChatCompletionMessageParam` 类型替换为自定义领域层的 `ChatMessage`。

### 4. 依赖注入与控制反转

#### [MODIFY] [agent-loop.ts](file:///d:/Projects/MyAgent/src/brain/agent-loop.ts)
- 物理移出对 `driver.ts`、`TokenEstimator.ts` 与 `prompts.ts` 的直接 import 依赖。
- 修改构造函数 `constructor(...)`，使其接收 `llmPort: LlmPort`，在运行时通过契约方法发起流式对话与历史总结提炼。

#### [MODIFY] [session.ts](file:///d:/Projects/MyAgent/src/brain/session.ts)
- 修改会话管理类，在实例化或执行后台压缩任务时面向 `TokenEstimatorPort` 进行 Token 水位决策。

#### [MODIFY] [index.ts](file:///d:/Projects/MyAgent/src/index.ts)
- 作为本项目的依赖装配根（Composition Root），在此处引入 `OpenAiLlmAdapter` 与 `TiktokenEstimator` 完成其实例化，并将其通过构造函数注入给大脑推理引擎。

## 风险与权衡

- **多态适配层的数据转换损耗**：大循环中需要将 `ChatMessage` 转换成 OpenAI 内部的 `ChatCompletionMessageParam`，在流式生成返回时再将 chunk 转换回 `LlmStreamEvent`。这会引入几行类型搬移和微小的内存开销，但由于模型通信时间为秒级，这种微秒级的内存模型转化完全可以忽略不计，换取了极其纯净的编译解耦。
- **单元测试路径全面断裂风险**：`test/brain/models.test.ts`、`test/brain/plugins.test.ts` 中多处依赖 `driver.ts` 或 `TokenEstimator.ts`。在执行阶段，必须细致调整所有测试代码头部的 import 引用路径，并重新校准 mock 机制，以确保回归测试 100% 通过。
