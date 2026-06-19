# 探索主题: 大脑 Domain 层 LLM 驱动器解耦与去污染

## 1. 问题定义
在当前的物理目录中，大模型的具体驱动实现（[driver.ts](file:///d:/Projects/MyAgent/src/brain/driver.ts)）、本地 Token 长度预估（[TokenEstimator.ts](file:///d:/Projects/MyAgent/src/brain/TokenEstimator.ts)）以及硬编码的提示词模板（[prompts.ts](file:///d:/Projects/MyAgent/src/brain/prompts.ts)）均直接平铺存放在核心领域层 [src/brain/](file:///d:/Projects/MyAgent/src/brain/) 目录下。
这导致“大脑皮层（Domain Core）”在编译期和逻辑上直接强耦合了 `openai` 官方 SDK、具体模型的 API 参数格式以及本地物理分词器 `js-tiktoken`，严重破坏了六边形架构中“业务领域核心应独立于具体技术框架与外部基础设施”的基本护栏。

本探索旨在通过定义纯净的 LLM Ports，将外部 SDK 依赖和驱动实现剥离至外围适配器，完成大脑的去污染。

## 2. 关键发现与调研结果
- **代码库现状**：
  - [src/brain/driver.ts](file:///d:/Projects/MyAgent/src/brain/driver.ts) 直接依赖并实例化了 `OpenAI` 客户端，并强耦合了其流式返回结构 `chunk.choices[0]?.delta`。
  - [src/brain/agent-loop.ts](file:///d:/Projects/MyAgent/src/brain/agent-loop.ts) 直接 `import { LlmDriver } from './driver.js'`，核心决策循环完全被具体大模型库的通信机制所绑定。
  - [src/brain/TokenEstimator.ts](file:///d:/Projects/MyAgent/src/brain/TokenEstimator.ts) 使用外部本地依赖 `js-tiktoken`，并依赖了 `openai` 库提供的入参类型定义 `ChatCompletionMessageParam`。
- **核实与洞察**：
  - 联网调研表明，在干净的六边形架构中，大语言模型（LLM）属于“次要/被动适配器（Secondary Adapter）”，应当以接口契约（Port）的抽象方式存在于 Domain Core 内部，而具体的 SDK 通信逻辑则在外围以实现类（Adapter）的形式存在，通过依赖注入（DI）由入口进行实例化装配。

## 3. 方案对比与推荐方向
| 评估维度 | 方案 A：纯粹的 Ports & Adapters 双向解耦 | 方案 B：仅做物理文件挪位置 (伪解耦) | 结论 |
| :--- | :--- | :--- | :--- |
| **物理位置** | 核心域定义 `src/brain/ports/LlmPort.ts` 契约；具体实现放入顶级独立基础设施层 `src/infrastructure/llm/`。 | 将 `driver.ts`、`TokenEstimator.ts` 物理移动至 `src/llm/` 并修改引用路径。 | **方案 A 占优**：做到了逻辑层面的接口隔离，而方案 B 仅做了文件分类。 |
| **依赖方向** | 核心大脑（`agent-loop.ts`）仅依赖 `LlmPort` 契约，彻底断开与 `openai` 的逆向编译耦合。 | 核心大脑依然在编译期直接 import `src/llm/driver.ts` 并传递 `openai` 特有类型。 | **方案 A 占优**：实现了控制反转 (IoC)，方案 B 依旧保留强耦合。 |
| **可扩展性** | 大脑无需修改即可无缝适配 Gemini, DeepSeek Native SDK，只需新建一个实现类。 | 切换其他厂商 SDK 时，必须深入大脑底座修改 `LlmDriver` 的流式解析和参数转换。 | **方案 A 占优**：具备极强的通用性和平台可移植性。 |
| **重构工作量** | **中等**：需要对消息格式定义 `ChatMessage` 进行解耦，并调整 `agent-loop.ts` 为构造器注入或上下文注入。 | **极低**：仅仅是移动文件和一键修复 `import` 路径。 | **方案 B 占优**：B 的改动非常简单。 |

**推荐路径**：
采用 **方案 A：纯粹的 Ports & Adapters 双向解耦**。
1. 在 [src/brain/](file:///d:/Projects/MyAgent/src/brain/) 目录下新建接口定义 [LlmPort.ts](file:///d:/Projects/MyAgent/src/brain/ports/LlmPort.ts)，定义不依赖第三方 SDK 的通用 `ChatMessage` 数据契约、`streamChat` 事件契约以及 `LlmPort` 接口规范。
2. 将 `LlmDriver` 改名为 `OpenAiLlmAdapter`，移出大脑目录并移动到顶级独立基础设施层 `src/infrastructure/llm/` 下，实现 `LlmPort`。
3. 将 `TokenEstimator` 物理分词计算和 `js-tiktoken` 同样剥离为基础设施服务（重命名为 `TiktokenEstimator` ），并在 Domain 层仅保留 `TokenEstimatorPort` 接口声明。
4. 修改 `Session`、`agent-loop.ts`，使其仅通过构造函数依赖 `LlmPort` 与 `TokenEstimatorPort`。在系统初始化入口（例如 `src/index.ts` ）装配外部的 `OpenAiLlmAdapter` 与 `TiktokenEstimator` 并注入。
5. 将硬编码的 [prompts.ts](file:///d:/Projects/MyAgent/src/brain/prompts.ts) 提示词模板模块，物理移入 `src/brain/prompts/` 专属子目录中，净化大脑根目录的视觉空间，使其完全物理内聚。

## 4. 约束、风险与未知项
- **流式返回值（AsyncGenerator）类型统一**：在不依赖 `openai` SDK 的情况下，工具调用片段（`tool_calls`）等结构在领域层需要有一套完全对应的自主 TS 契约接口，这会带来一定的类型搬移工作。
- **性能开销**：在 Adapter 层进行 Domain-Message 到 OpenAI-Message 的双向类型格式转换，会有极微小的内存分配开销，但在大模型请求的 I/O 时延面前可忽略不计。

## 5. 否决方案
- **直接删除 TokenEstimator 并用字符数估算**：虽然能瞬间解除对 `js-tiktoken` 的依赖，但这会导致 Token 估算产生严重偏差（中文和代码在 char-length 与 token-length 的转换比例上极不稳定），进而导致上下文爆仓或死循环熔断被误触发。因此该方案予以否决，保留 Token 精确计算职责但改用 Port 隔离。
