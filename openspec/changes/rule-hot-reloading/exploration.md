# 规则热加载 (Rule Hot-Reloading) 深度调研报告

## 1. 调研背景
在之前的讨论中，我们发现全局规则（`global_rules.md`）和局部规则仅在会话启动时读取一次。为了追求“所改即所见”的体验，初步设想是“每次请求前重构 System Prompt”。
**但基于“调研”指令的强制约束**，我立即跳出了当前代码库，深入对比了 `hermes-agent` 和 `claude-code` 等前沿开源项目的源码，并结合了最新的大模型 Prompt Caching（提示词缓存）机制进行了全网检索验证。

## 2. 竞品源码深挖发现

### 2.1 `hermes-agent` 的惊人发现：刻意禁止热加载
在深入剖析 `hermes-agent` 的 `conversation_loop.py` 源码时，我发现了一段极其重要的架构注释：
> *"Hermes invariant: the system prompt is built ONCE per session and replayed verbatim on subsequent turns... This is intentional — system prompt modifications break the prompt cache prefix."*
**(译：Hermes 铁律：System Prompt 每个会话只构建一次并在后续原封不动地重放……这是故意的——任何对 System Prompt 的修改都会破坏提示词缓存的前缀。)**

`hermes-agent` 不仅没有做热加载，甚至还专门写了代码将 System Prompt 存入 SQLite 数据库中，强制整个会话期间死锁不变。

### 2.2 联网交叉验证：Anthropic Prompt Caching 机制
结合 Web 检索（"Anthropic prompt caching"），证实了 `hermes-agent` 这一设计的深意：
1. **严格的前缀匹配**：大模型的 Prompt Cache 基于密码学哈希。System Prompt 位于请求的最前端，如果它发生**哪怕一个字符的改变**，都会导致后面所有的多轮对话历史缓存**瞬间全部失效 (Cache Miss)**。
2. **灾难性的成本与延迟**：如果我们在每次 `chat()` 前去热加载读取硬盘，只要文件发生微小变动（或者插入了动态的时间戳），原本能节省高达 90% 的 Token 费用和大幅缩减的首字延迟将彻底泡汤，每一轮对话都会按全量重新计费和推理！

## 3. 结论：推翻此前的草率建议

我必须推翻我之前“强烈推荐方案 A（每次请求前硬重构）”的草率结论。之前的推演仅仅局限于 Node.js 的 I/O 性能，却完全忽略了大模型前沿架构中最致命的“缓存失效”成本。

### 最终架构决议：
1. **维持现状（绝对不进行高频热加载）**：我们当前的架构（只在 `SessionContext` 初始化和执行 `/skill pin` 时重构 System Prompt）在无意中**完美契合了 LLM 提示词缓存的最佳实践**。
2. **如何满足用户的修改需求？**：
   - 规则这种低频变动的基石文本，应保持只在 `/resume` 恢复会话或新启 `npm run dev` 时加载。
   - 如果用户确实在半途改了规则并希望立刻生效，必须通过手动的 Slash Command（例如后续可以开发一个专门的 `/reload-rules` 指令，并明确警告用户该操作会重置大模型缓存池）来显式触发。

**这是一次非常深刻的架构认知升级。**
