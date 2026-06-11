## 背景

目前，MyAgent 会话管理器（ `SessionManager` ）在处理外部规则和临时技能时缺乏统一的控制策略：
1. 全局人设与安全红线从磁盘规则文件读取并组装为系统提示词（System Prompt），该提示词在会话启动时载入后即锁定；但如果需要在交互中热载入更新全局规则，无法在保留会话历史的同时无感生效。
2. 缺乏对工作区项目级局部规则文件（如项目根目录下的 `.myagent.md` ）的探测与加载。
3. 临时技能挂载在每轮对话中动态执行，但没有针对局部规则的会话级内存锁定机制。如果中途发生文件修改或重复读取，会直接造成大模型 API 前缀哈希变化，从而频繁击穿云端前缀缓存（Prompt Caching），引发显著响应延迟和高 Token 消耗。

因此，需要在架构层面重构规则的生命周期管理，建立基于内存缓存锁定和动态插入定位的技术机制。

## 目标与非目标

**目标:**
- 实现对工作区局部规则文件 `.myagent.md` 的自动发现与单次加载。
- 引入会话生命周期内的外部规则内存缓存锁定（Session-scoped Memoization），单次会话循环中默认不重新读取磁盘规则，保证 API 请求前缀哈希完全稳定。
- 扩展上下文适配器（ `ContextAdapter` ）逻辑，将读取到的局部规则内容包裹于结构化 XML 隔离标签 `<project_rules>` 中，并动态插入至最后一条 `user` 消息之前（ `role: 'system'` ），兼顾高规则权重与防 ReAct 协议交错。
- 提供公有的热重载接口，支持清除内存缓存以在下一次请求中重新载入最新规则。

**非目标:**
- 不引入自动文件监控器（File Watcher）进行静默热载入，规避意料之外的哈希抖动；仅支持显式手动指令触发重载。
- 不修改底层大模型驱动（Driver）的缓存配置下发，仅在上下文组装层（ `ContextAdapter` ）对消息进行控制。
- 不在 System Prompt 头部注入任何高频变动的秒/毫秒级精确时间戳；时间戳变量应移至 `user` 消息尾部，或采用日期级别精度。

## 架构决策

### 1. 基于会话管理器的规则缓存包装 (Session-scoped Cache Wrapper)
- **方案**：在 `SessionManager` 中维护 `cachedGlobalRules` 与 `cachedLocalRules` 私有状态。会话初次载入时读取相应磁盘规则文件写入该状态。交互循环期间，均直接使用内存状态参与提示词拼装，而不再发起 `fs.readFile` 磁盘 I/O。
- **理由**：实现了 I/O 读取与交互循环的物理隔离。极大提升了多轮对话中静态前缀的 Byte-stable 一致性，保障前缀缓存命中。
- **备选方案**：在 `ContextAdapter` 内部自行通过 `memoize` 函数锁定。
  - *舍弃原因*：`ContextAdapter` 属无状态的消息格式转换器，在此处耦合 I/O 状态管理违背了职责单一原则（Single Responsibility Principle）。

### 2. 局部规则专属 XML 隔离插入 (XML Tagging & Precise Location Injection)
- **方案**：在 `ContextAdapter` 接口中扩展 `assemble` 方法以接收局部规则：`assemble(baseHistory, transientContext?, localRules?)`。在默认实现类 `DefaultContextAdapter` 中，将 `localRules` 封装为 `role: 'system'` 且用 `<project_rules>` 标签包裹的消息，与临时技能（ `<transient_skill>` ）以特定顺序插入至最后一条 `user` 消息之前。
- **理由**：使用 XML 标签是主流大模型（如 Anthropic Claude ）对复杂约束隔离的最佳实践，防止模型在长上下文中注意力涣散。插入到最后一条 `user` 之前，能保证后续的 assistant 与 tool 交互链角色轮替不被中断，规避 LLM API 对交错协议的严格约束检查。

### 3. 暴露显式重载接口 (Explicit Reloading Interface)
- **方案**：在 `SessionManager` 类中增加公有方法 `reloadRules()`，用于将内存中的规则缓存全部置空。当交互端（如 REPL 命令行输入了重载指令 `/reload-rules` ）调用此方法时，下一轮 `run` 循环会强制从磁盘读取最新规则。
- **理由**：为开发者测试全局规则和局部规则的变更提供了极大的便利，且在此阶段缓存失效是开发者预期的行为。

## 风险与权衡

- **[风险点] 规则文件更新后，由于内存锁定导致修改未及时反映在会话中**
  - **缓解策略**：在会话首次启动以及执行 `/reload-rules` 时，在终端打印明确的锁定提示与重载状态日志，告知用户规则已经载入并锁定，以及如何使用重载指令。
- **[风险点] 频繁变动的时间戳破坏 Prompt Cache 命中率**
  - **缓解策略**：剥离精确的毫秒值，仅在 System Prompt 的末尾（甚至在 user 消息中）放置日期限制信息（如 `Today's date is YYYY-MM-DD` ）。其哈希每日仅在跨越午夜时发生一次突变，以极低的成本维持全天的温暖缓存。
