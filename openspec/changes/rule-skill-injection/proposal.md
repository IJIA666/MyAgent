## 改造原因

大模型需要在对话上下文中动态感知“全局纪律（Global Rules）”、“局部约束（Local Rules）”以及“扩展能力（Skills）”。目前 `src/brain/prompts.ts` 仅使用硬编码的静态文本，缺少动态上下文组装机制。构建这套注入引擎，能够赋予 Agent 极高的扩展性，也是实现架构解耦与复杂业务落地的核心基石。

## 变更内容

- 引入支持“全局规则”、“局部工作区规则”及“技能列表”扫描的上下文加载器 (Context Loader)。
- 采用**实时热更新 (Hot Reload)**机制，在每次构建 Prompt 时执行 I/O 读取，使得规则修改即刻生效，无需重启进程。
- 重构 `src/brain/prompts.ts` 的 `buildSystemPrompt` 函数。
- 引入 **XML 结构化隔离**排版策略，使用 `<global_rules>`、`<project_rules>` 等包裹外挂文本。
- 引入 **混合式技能注入模式 (Tool-driven Index + Manual Command)**：默认只注入技能的元数据索引 `<available_skills>`，大模型可自主调用内部 Tool 加载技能全文，或由用户通过 `/skill` 命令行强行挂载。

## 业务能力

### 新增业务能力
- `context-injection-engine`: 负责动态读取磁盘上隔离存放的 Markdown 规则与技能，并将它们以 XML 格式安全注入大模型的系统级上下文。

### 修改业务能力
无。这是一个新增的底层基础设施层能力。

## 影响范围

- **核心影响**: `src/brain/prompts.ts` (Prompt 组装逻辑彻底重构)
- **新增模块**: 可能新增 `src/brain/contextLoader.ts` 等负责读取规则文件的工具类。
- **配置隔离**: 引入 `.agent/` 和 `.agentrules` 相关的探测与读取逻辑，将读取用户文件系统中的配置。
- **依赖变更**: [Amend 追加] 引入 `gray-matter` 第三方包以实现标准、健壮的 YAML Frontmatter 解析。
