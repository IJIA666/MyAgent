## 改造原因

目前智能体的长期记忆（RAG）召回机制在每次会话交互中会根据用户最新的输入动态检索，并追加到 `systemMessage` 的尾部。这导致全局 System Prompt 的哈希指纹随着用户话题在每次交互中发生变动。
根据主流大模型（如 DeepSeek、OpenAI、Anthropic）的前缀匹配缓存（Prompt Caching）机制，这会引发持续性的前缀哈希失配，导致后面所有的对话历史缓存全部被击穿。大面积的缓存失效不仅增加了响应延迟，也产生了高昂的 Token 算力费用。
此外，当前系统在运行期缺乏对 RAG 是否启用的开关控制，并且如 RAG 检索分数过滤阈值、死循环熔断频次、上下文提炼与硬截断阈值等核心参数均处于硬编码状态，无法适应不同模型的上下文窗口和各类网络部署环境，亟需进行抽提与优化。

## 变更内容

1. **缓存防击穿注入优化**：修改长期记忆 RAG 的注入点。通过锁定 System Prompt 为绝对固定的静态前缀，并将 RAG 召回的记忆内容合并挂载在最新一条 User 消息中，从而达到 100% 保护 System Prompt 与历史对话缓存的目的。
2. **核心限额与可配置项抽提**：在环境变量中扩展配置控制项，允许配置 RAG 开关、检索阈值、向量召回数量、自省最小对话轮数，以及上下文压缩（Compaction）和死循环防护（Loop Prevention）中的所有硬编码参数。

## 业务能力

### 新增业务能力
- `rag-cache-optimization`: 实现 RAG 长期记忆召回机制的 Prompt Caching 缓存一致性优化。
- `config-runtime-limits`: 将 RAG 核心参数、死循环熔断频次及上下文压缩提炼等硬编码限额阈值统一抽提为环境配置参数。

### 修改业务能力
<!-- 本次不修改任何既有的业务能力需求规格。 -->

## 影响范围

- **核心代码**：`src/config/loader.ts`（环境加载）、`src/config/types.ts`（配置定义）、`src/core/usecases/LongTermMemoryPlugin.ts`（RAG 插件）
- **核心服务**：`src/core/usecases/CompactionService.ts`（压缩服务）、`src/core/usecases/LoopPreventionPlugin.ts`（防死循环熔断插件）
- **集成测试**：相关的测试用例和配置文件（需要补充或修正相应的测试用例）
