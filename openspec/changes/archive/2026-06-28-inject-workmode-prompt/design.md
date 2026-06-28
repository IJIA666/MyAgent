## 背景

本系统当前的架构设计中，运行态的环境参数（例如当前的 `cwd` 目录与动态日期 `date`）是通过 `buildSystemPrompt` 同步拼装到位于第 0 项的 System Prompt 里的。由于主流 LLM 服务商对多轮交互中上下文缓存（Context Cache）的设计是基于首部长前缀哈希计算的，这会导致只要用户执行 `cd` 切换目录，或者跨天运行，最头部的 System Prompt 发生变动就会引发后面数万 Token 对话历史的前缀缓存全部失效雪崩。

此外，大模型对于底座的 `WORK_MODE` 状态（Safe、Auto、YOLO、Plan）缺乏前端的主动心智感知，安全模式只在底层的 `terminal.ts` 与 `file-system.ts` 拦截网中进行单向拦截。当用户切换到 `Plan`（只读）模式时，大模型会因为对此不可知，依然盲目生成大量的写盘和删除工具调用，导致频繁触发底层安全警告拦截，引发无效的大模型往返消耗与死循环（如 `Loop Limit` 限制爆仓）。

---

## 目标与非目标

**目标:**
1. **System Prompt 绝对静态化**：从 `buildSystemPrompt` 拼装中彻底剔除 `<cwd>` 与 `<date>` 动态标签，使得 System Prompt 哈希在会话内完全恒定，实现最大化、无污染的 Prompt 缓存命中。
2. **末尾消息气泡动态注入 (心智防线)**：在发送给 API 载荷组装的瞬时，克隆并修改最新一条 User 消息，将瞬时的 `workMode`、`cwd`、`date` 打包在 `<system-reminder>` XML 标签内追加在消息尾端，实现心智级红线规约而不破坏历史缓存。
3. **动态工具安全裁剪 (物理防线 - 可选增强配置)**：在 Plan 模式下支持动态过滤剔除所有声明为 `securityCategory = 'write'` 的工具定义，在 API 载荷级别对大模型隐藏写工具，从而从物理层面屏蔽大模型的写意图。
4. **彻底规避并发忙锁断言**：在安全过滤钩子触发降级（例如读取凭据文件降级到 Safe 模式时），只更新 SessionContext 的内存状态，而不触碰 `messageHistory` 的写链路，避开 `isProcessing === true` 的锁限制，实现无死锁异步更新。

**非目标:**
1. 不会在物理的 `messageHistory` 历史消息数据库中持久化写入 `<system-reminder>` 气泡，该行为仅在向大模型接口发送 API Payload 的瞬间作为内存级动态装配，避免污染用户的实际聊天历史记录。
2. 不会削弱或取消系统底座 `terminal-guard.ts` 与 `file-system.ts` 对敏感写操作的过滤机制（它们仍将作为物理级的最后底盘保障）。

---

## 架构决策

### 1. System Prompt 的去动态化改造
* **决策点**：修改 [prompts.ts](file:///d:/projects/MyAgent/src/core/usecases/brain/prompts.ts) 中的 `buildSystemPrompt`。
* **做法**：从 System Prompt 中彻底移除高频变动的 `<date>` 和 `<cwd>` 模块，保留 `<os>` 标签（因 `os` 平台作为进程级静态常量，在会话生命周期内绝对恒定，保留它对大模型生成环境命令有重要参考价值，且不会破坏 Context Cache 缓存命中）。

### 2. LLM 发送载荷前的最后消息气泡追加 (心智轨)
* **决策点**：在 LLM 调用前的消息载荷转换处（如 `runner/llm.ts` 或 `DefaultContextAdapter.ts` 的 `toLLMMessages`）进行拦截。
* **做法**：
  1. 拦截正在组装的 `messages` 数组。向前追溯定位到**最近/最新的一条角色为 `user` 的消息**（以兼容最末消息是 `tool` 或 `assistant` 的多步工具执行场景，防止直接在末尾拼入导致 API 角色交替规则校验失败报错）。
  2. 从 `SessionContext` 中读取当前的 `cwd` 与当前的 `workMode` 内存状态。
  3. 克隆该 User 消息，将其 content 内容末尾追加如下气泡文本：

     ```xml
     <system-reminder>
     [System Notification]
     Current Date: ${dateStr}
     Current Workspace Cwd: ${cwdStr}
     Current Active WorkMode: ${workMode} (Note: If it is 'Plan' mode, you are strictly restricted to read-only. Do not invoke any write tools!)
     </system-reminder>
     ```
  4. 将包装后的消息发送给大模型 API，而内存中的 `messageHistory` 数据库保持原样不变。

### 3. Plan 模式下的 Tool 列表动态过滤 (物理轨)
* **决策点**：在 LLM 载荷组装的 `tools` 参数映射前。
* **做法**：
  1. 引入全局配置 `enable_plan_tool_stripping` 开关。
  2. 如果该开关为 `true` 且当前 `workMode === 'Plan'`，在生成 LLM `tools` 定义字段时，将 `ToolRegistry` 注册表中所有 `securityCategory === 'write'`（如文件覆盖、终端命令执行等）的工具定义从 definitions 数组中直接 `filter` 剔除。
  3. 大模型在 API definitions 中不可见这些写工具，在思维链中自然不会生成越权 Tool 调用。

---

## 风险与权衡

### 1. [风险点] 模式切换时的 Tools 数组改变导致瞬时缓存击穿
* **原因**：在 LLM 接口哈希比对中，`tools` 的定义数组也是前缀哈希的组成部分。如果在会话中从 `Auto` 模式切换至 `Plan` 模式使得工具有增删，必然导致该轮会话的整个历史缓存全部击穿失效。
* **权衡与缓解**：我们将“动态工具裁剪”设计为一个**可配置的可选功能**（`enable_plan_tool_stripping`，默认设为 `false`）。
  * *侧重缓存性能的用户*：关闭此开关，始终维持相同的工具定义列表。在 `Plan` 模式下完全依靠心智轨 `<system-reminder>` 进行软性规约，实现极速缓存命中。
  * *侧重高安全屏障的用户*：开启此开关，物理屏蔽写工具，并在模式切换的那一轮对话中接受当轮缓存失效重读的代价。

### 2. [风险点] 忙锁冲突导致降级崩溃
* **原因**：当工具拦截检测到敏感文件，在 Hook 回调内需要将模式降级为 `Safe`。由于此时处于会话执行中，`isProcessing === true` 强行锁定消息历史。如果此时同步刷新 System Prompt 会抛错中断导致系统崩溃。
* **缓解策略**：降级触发时，只需轻量级更新内存 `sessionContext.setWorkMode('Safe')`，无需在此同步修改 `messageHistory` 中的首条消息。当当前迭代完成、准备进入下一轮 LLM 轮次时，LLM 请求装配会在 `isProcessing` 释放的非锁定阶段在外层循环自动抓取最新的内存状态并将其拼接进最后的 User 消息气泡，天生同步且安全。
