# 探索主题: 高危缺陷修复方案设计

## 1. 问题定义
针对项目根基缺陷排查中发现的 3 个高危缺陷 (H-1、H-2、H-3) 进行底层实现分析与架构设计。目标是消除硬编码路径、双轨制加载职责割裂、异步通知时序覆盖竞态，以及不符合大模型 API 规范的消息序列，为后续进入任务落地打下健壮的设计基础。

## 2. 关键发现与调研结果
- **代码库现状**：
  - **H-1**：[contextLoader.ts](file:///d:/projects/MyAgent/src/core/usecases/contextLoader.ts) 维护着全局模块级变量 `skillsCache` 与硬编码路径，而 [RuleManager.ts](file:///d:/projects/MyAgent/src/core/usecases/RuleManager.ts) 却使用 `process.cwd()` 独立加载规则，导致技能与规则双轨割裂且存在多会话并发污染风险。
  - **H-2**：[context.ts](file:///d:/projects/MyAgent/src/core/domain/context.ts) 异步使用 `nextTick` 调度通知落盘，但同步在 [plugin-runner.ts](file:///d:/projects/MyAgent/src/core/usecases/plugin-runner.ts) Hook 退出时覆写 history，时序极易竞态。
  - **H-3**：[DefaultContextAdapter.ts](file:///d:/projects/MyAgent/src/adapters/context/DefaultContextAdapter.ts) 将 `recentFiles` 拼为 system 角色插入历史第 2 位，破坏了 OpenAI 的 system 必须在首位的协议 Spec。
- **核实与洞察**：
  根据对 Node.js 动态配置与插件发现最佳实践的调研，消除全局共享的有状态缓存（如全局 `skillsCache`），采用实例级的 Manager 隔离，是解决并发污染的行业共识。此外，取消隐式的 Event Loop 异步调度（如 `nextTick`），改用确定性的同步合并，能消除大部分分布式时序竞态问题。

## 3. 方案对比与推荐方向

### H-1: 规则/技能加载与路径硬编码修复
| 评估维度 | 方案 A (轻量全局传参) | 方案 B (Manager 实例隔离) | 结论 |
| :--- | :--- | :--- | :--- |
| **会话隔离性** | 弱 (全局 skillsCache 导致并发工作区污染) | 强 (跟随 Session 实例隔离) | 方案 B 占优 |
| **重构成本** | 低 (仅修改签名) | 中 (调整 prompts 依赖关系) | 方案 A 占优 |
| **架构演进** | 差 (保留全局有状态模块) | 优 (完全消除职责割裂与双轨) | 方案 B 占优 |

**推荐路径**：采用 **方案 B**。将技能加载机制移入 `RuleManager` 统一管理，`contextLoader` 彻底无状态化。这虽然增加了少量重构工作，但根除了跨会话污染这一严重的安全隐患。

### H-2: 通知消息覆写竞态修复
| 评估维度 | 方案 A (收网式最终 Flush) | 方案 B (同步合并去 nextTick) | 结论 |
| :--- | :--- | :--- | :--- |
| **确定性** | 中 (仍存在 nextTick 时序副作用) | 100% 确定性 (全同步数据流) | 方案 B 占优 |
| **时序安全** | 较好 (强制 flush 挽回丢失消息) | 完美 (物理消除覆写窗口期) | 方案 B 占优 |
| **可测试性** | 差 (涉及微任务队列调试) | 好 (纯同步状态比对与写入) | 方案 B 占优 |

**推荐路径**：采用 **方案 B**。彻底移除 `process.nextTick`，让通知仅安全暂存在队列中，由 `AgentLoop` 在每个交互阶段结束的同步上下文中显式安全合并。

### H-3: system 消息顺序兼容性修复
| 评估维度 | 方案 A (改角色为 User) | 方案 B (内容物理合并) | 结论 |
| :--- | :--- | :--- | :--- |
| **协议合规** | 中 (可能因连续 user 消息被拒) | 完美 (严格遵循 user/assistant 交替) | 方案 B 占优 |
| **模板拼装** | 极简 | 简易 (仅几行模板拼接) | 方案 A 略优 |

**推荐路径**：采用 **方案 B**。将 `<recent_files_inventory>` 直接合并在 checkpoint 消息的 user content 尾部， 100% 绕过所有平台千奇百怪的 Spec 拦截。

## 4. 约束、风险与未知项
- 重构 `RuleManager` 时需确保 `SessionContext` 的构造函数中不急于加载未配置的技能，避免因为 `appConfig` 注入的时延差引起依赖崩溃。
- `buildSystemPrompt` 参数被多处使用（包括测试文件），重构时需兼容历史调用。

## 5. 否决方案
- **H-2 方案：使用 isProcessing 守卫直接 return**：此方案会导致通知在忙碌时被永远丢弃，无法保障通知的最终递达。
