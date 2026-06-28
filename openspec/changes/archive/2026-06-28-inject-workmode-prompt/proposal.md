## 改造原因

目前本系统在安全工作模式（WORK_MODE）和当前工作路径（cwd）的管理上，存在两个核心痛点：
1. **智能体生成侧的“心智不知情”**：大模型的系统提示词（System Prompt）中并未灌输当前的 `WORK_MODE` 状态（如 Safe/Auto/YOLO/Plan）。在 `Plan`（只读）模式下，大模型依旧会盲目尝试生成写盘命令或文件删除命令。这些命令在底座执行前虽然会被 `file-system.ts` 和 `terminal.ts` 的安全拦截网强行掐断（BLOCKED），但大模型会因为对“被阻断”的真实原因缺乏预期，从而在会话回路中反复尝试生成新的写动作。这会导致智能体陷入死循环，耗尽会话 Token 并严重破坏交互体验。
2. **System Prompt 的缓存雪崩（Prompt Cache失效）**：系统在 `buildSystemPrompt` 拼装时，在处于消息队列最前端的 System Prompt (`messageHistory[0]`) 内部引入了高频变化的动态参数（如 `<date>` 和 `<cwd>`）。大模型服务商的 Context Cache 命中依赖于长前缀的物理一致性。由于用户执行 `cd` 切换路径、跨天等因素会导致 System Prompt 头部哈希变动，使得其后积攒的数万 Token 对话历史的缓存全部瞬间失效。

---

## 变更内容

为解决上述痛点，本变更将重构本系统的环境注入与提示词缓存架构：
1. **System Prompt 绝对静态化**：从 `src/core/usecases/brain/prompts.ts` 的 `buildSystemPrompt` 中彻底移出 `<date>`, `<cwd>`, `<os>` 等易变的 volatile 上下文，使 System Prompt 保持物理级静态，实现会话周期的 Context Cache 高效持久命中。
2. **末尾消息气泡动态注入 (心智防线)**：在发送给 LLM 接口前，于 `agent-loop` 载荷组装期，动态获取当前内存中的 `workMode`、`cwd` 与日期，并将其以 `<system-reminder>` XML 标签包裹的系统提醒气泡，追加在最后一条 User 消息的尾部。由于变动点被置于整个消息序列的末端，这既保全了前面长前缀的缓存命中，又实现了模型对当前工作模式和路径的零延迟强感知与心智规约。
3. **动态工具物理裁剪 (物理防线 - 可选增强配置)**：在系统全局配置中引入 `enable_plan_tool_stripping` 配置项。若开启，当处于 `Plan` 模式时，系统会在向 API 组装工具集时自动把所有 `securityCategory = 'write'` 的修改类 Tool 定义从 definitions 数组中物理剔除。模型在 API 级别看不见写工具，杜绝了生成写调用的可能；若关闭，则保持工具集不变，仅依赖心智气泡规约。这使用户能在“高安全物理防线（牺牲当轮缓存）”与“高缓存效率（心智规约）”之间灵活权衡。

---

## 业务能力

### 新增业务能力
- `dynamic-prompt-cache`: 剥离 System Prompt 头部高频变化参数，确保大模型上下文长前缀缓存绝对稳定命中。
- `system-reminder-injection`: 实现多轮会话末端 User 消息的系统 `<system-reminder>` 气泡动态拼装注入与物理包裹。
- `dynamic-tool-stripping`: 支持在 Plan 模式下针对写倾向 Tool 声明进行动态过滤裁剪与全局配置开关控制。

### 修改业务能力
无（本变更主要属于系统底层架构、安全机制和性能优化的重构，不涉及已有 Spec 级别的既有需求规则变化）。

---

## 影响范围

* **受影响的模块**：
  * 提示词生成模块：`src/core/usecases/brain/prompts.ts`
  * LLM 消息流调度与载荷组装模块：`src/core/usecases/engine/agent-loop.ts` 或 `src/adapters/context/DefaultContextAdapter.ts`（取决于具体的载荷最终封装实现）。
  * 全局配置模块：`src/config/types.ts` 和 `src/config/loader.ts`。
* **依赖与兼容性**：
  * 修改后，需要更新或重构与之相关的单元测试用例，防止被静态化的 system 提示词断言校验因参数缺失而报错。
  * `isProcessing` 忙状态并发锁保持不受影响，所有动态修改仅在 LLM 请求发送前的瞬时 payload 装配阶段生效。
