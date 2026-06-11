# 探索主题: 智能体规则注入与缓存优化策略

## 1. 问题定义
在智能体（Agent）的会话调度中，全局规则（核心人设、安全红线）与局部规则（项目级特定规范）的更新存在两难：若将其作为 `System Prompt` 频繁热重载，会导致大模型的前缀缓存（Prompt Caching）频繁失效，极大增加 API 响应延时与 Token 开销；若为了保护缓存而将其混入 `User Message` 尾部，又会导致约束规则对大模型注意力的控制权重降级，并在长对话轮次中产生规则失忆。本主题旨在探索如何在两者之间取得工程平衡。

## 2. 关键发现与调研结果
- **代码库现状**：在 MyAgent 中，原有的临时技能挂载在主循环中硬编码执行 `snapshotContext.push/pop`。在重构为 `ContextAdapter` 接口后，系统将临时技能挂载到了最新一条 `user` 消息的前面。这在一定程度上保护了 System Prompt 的头部缓存，并解决了 ReAct 工具调用中的协议交错问题。但在外部项目局部规则内容文件的热加载与前缀锁定上，尚未有专门的机制。
- **核实与洞察**：
  1. **Hermes-Agent 策略**：System Prompt 保持静态锁死在 SQLite 数据库中，通过 `pre_llm_call` 拦截器将所有动态变化的内容追加拼接在当前轮次的 `User Message` 尾部。
  2. **Claude-Code 策略**：采用 `appendSystemPrompt` 分块机制，并将 `getUserContext`、`getSystemContext` 方法通过 `lodash-es/memoize` 进行缓存锁定。单次运行期内，即便磁盘上的 `.claude.md` 规则文件被修改，哈希前缀也不会发生抖动。
  3. **Opencode 策略**：在 `packages/llm/src/cache-policy.ts` 中实现 `auto` 策略，自动将 `CacheHint`（显式缓存断点）挂载在最新一条 user 消息上（`latest-user-message`），以此作为 Tool-use 循环的缓存切分点。
  4. **Gemini-CLI 策略**：利用 Google Cloud GenAI 显式的 `cachedContent` 机制，在 REST 载荷根部透传资源 ID 以强行绑定云端缓存。

## 3. 方案对比与推荐方向
| 评估维度 | 方案 A：混入 User 消息 (如 Hermes) | 方案 B：System 尾部段 + 单次 I/O 锁定 (如 Claude-Code) | 结论 |
| :--- | :--- | :--- | :--- |
| 缓存命中率 | 极高 ✓ | 高 ✓ | 方案 A 略优 |
| 规则控制权重 | 弱（易被长对话稀释） ✗ | 强（System 级人设控制） ✓ | 方案 B 占优 |
| 实现复杂度 | 低 ✓ | 中（需处理 I/O 缓存与清理） ✗ | 方案 A 占优 |
| 协议与防交错 | 难以兼顾 ReAct 多轮调用 ✗ | 极佳（配合 ContextAdapter 定位） ✓ | 方案 B 占优 |

**推荐路径**：
在 MyAgent 项目中，推荐采用**方案 B**（静态 System 段 + 动态前置挂载，并结合 Memoize 缓存锁定）。
* 全局规则与可用技能大纲索引在会话启动时组装为静态 `System Prompt` 锁定，获取最高的基础缓存；
* 变动的局部规则/临时技能在最新一条 `user` 消息之前通过适配器注入，并包裹在 `<project_rules>` 等 XML 标签中；
* 使用内存缓存锁定外部规则文件的 I/O 读取，使得单次会话循环中前缀完全不变，保障大模型前缀缓存命中率最大化。

## 4. 约束、风险与未知项
- **动态变量干扰**：如果 System Prompt 或规则中包含了当前毫秒级时间戳、或是频繁变动的目录树内容，前缀缓存哈希仍会被彻底打碎。必须小心设计“压舱石”前缀，剔除一切非必要的动态环境属性。

## 5. 否决方案
- **每轮逐次 Getter 热加载方案**：每次 LLM 交互时现场读取最新磁盘文件重新拼接 System Prompt。被否决的原因是会导致提示词哈希完全失控，极易频繁击穿缓存，造成无法接受的延迟与高昂的 API 调用成本。
