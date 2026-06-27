# 探索主题: 中危缺陷设计与分析 (M-1, M-2)

## 1. 问题定义

在完成高危缺陷修复后，对项目中存在的两处中危缺陷进行针对性分析与方案架构升级：
1. **M-1：`CompactionService.compact()` 截断时存在"信息真空"窗口期**
   当 Token 爆仓触发硬截断，若此时后台异步摘要尚未生成，系统会因固定条数（8 条）截断丢失原有的用户交互意图，产生信息断层和协议合规风险。
2. **M-2：`ContextRepository.saveState()` 吞掉所有 I/O 异常**
   物理落盘捕获异常后被完全静默，致使磁盘满、权限受限等异常无法观测。

---

## 2. 关键发现与调研结果

- **代码库现状**：
  - `CompactionService.ts` 的 `compact()` 通过直接调用 `this.context.truncateHistory(this.compactionRetainCount)` 进行截断。
  - `ContextRepository.ts` 缺少统一日志模块的引用，其 `saveState()` 内捕获的异常由于没有任何输出通道，完全成为了可观测性盲区。

- **隐性边界与设计补全**：
  - **API 依赖补全**：`SessionContext` 中目前并没有 `truncateHistoryFromIndex(startIndex)` API。本次重构必须显式包含该方法的开发，将其作为修改 `context.ts` 的核心设计。
  - **配置语义映射**：新方案不能废弃 `compactionRetainCount` 配置项的控制权。我们需要平滑地将其控制语义从“固定消息条数”升级映射为**“滚动窗口物理保留的最近 User 消息轮数（User count）”**。默认的保留值设为 `4`（相当于最近 3.5 轮会话交互）。
  - **倒数 User 消息边界定义**：扫描方向从 `history.length - 1`（末尾，包含当前交互轮）向左反向扫描，仅限于 index 1 及之后的有效范围（绝对禁止扫描或篡改 index 0 的 system 消息），过滤出 `role === 'user'` 的消息总数。一旦达到 `compactionRetainCount`（如 4）时，以该 user 消息的索引作为 `cutoffIndex` 起点。

---

## 3. 方案对比与推荐方向

### M-1: 硬截断机制设计对比

| 评估维度 | 方案 A (固定消息条数截断) | 方案 B (滚动窗口 User 轮数截断) | 选型分析 |
| :--- | :--- | :--- | :--- |
| **连贯性** | 弱 ✗ (可能只剩 tool 消息碎片，丢失 user 意图，产生信息真空) | 强 ✓ (保留完整 user 交互流，即使无摘要大模型也能理解当前场景) | 方案 B 占优 |
| **契约合规性** | 差 ✗ (极易截断在 tool/assistant 消息，造成非首位 system 接口 400 崩溃) | 好 ✓ (截断起点永远在 `user` 角色消息处，天然符合交替流规范) | 方案 B 占优 |
| **适应性** | 差 ✗ (固定条数不能反映真实的交互轮数，极易在 ReAct 密集工具调用下爆仓) | 强 ✓ (基于对话轮次，动态伸缩以承载完整的工具调用闭环) | 方案 B 占优 |

**推荐路径**：采用 **方案 B**。
- 将 `compactionRetainCount` 配置的物理单位重新定义为“保留的 User 消息轮数”（默认值 4）。
- 硬截断前置守卫逻辑修改为：若历史中包含的 `user` 角色消息总数 `<= compactionRetainCount`，则不予截断，直接返回 `false`。
- 在 `CompactionService` 中反向扫描出倒数第 `compactionRetainCount` 个 `user` 角色消息（包含当前最新交互轮），以此作为 `cutoffIndex` 切片起点。
- 在 `SessionContext` 中新增 `truncateHistoryFromIndex(startIndex)` API 供 `CompactionService` 调用。

### M-2: 写盘异常处理对比

| 评估维度 | 方案 A (静默吞掉 I/O 异常) | 方案 B (记录警告日志保持可观测性) | 选型分析 |
| :--- | :--- | :--- | :--- |
| **可观测性** | 无 ✗ (落盘失败无任何日志，无法发现磁盘满或权限错误) | 强 ✓ (记录详细的 warning 日志，提供排查线索) | 方案 B 占优 |
| **流程阻断性** | 不阻断 ✓ (不会因为写盘异常导致核心交互中断) | 不阻断 ✓ (仅警告，依然保持流程继续，不阻断核心) | 方案 A、B 对等 |

**推荐路径**：采用 **方案 B**。
- 在 `ContextRepository.ts` 头部引入统一日志组件 `logger`。
- 在 `saveState()` 的 `catch` 块中调用 `logger.warn` 打印警告，但不抛出，依然维持会话流程不中断。

---

## 4. 约束、风险与未知项

- **M-1 对单元测试的影响**：由于硬截断算法升级为寻找 user 消息，依赖于旧有固定 retainCount 的单元测试用例可能会受到影响，修改时需对 `test/brain/CompactionService.test.ts` 进行同步适配。

---

## 5. 否决方案

- **方案 A (同步等待 AI 摘要)**：在 `compact()` 中将异步提炼改为 `await` 同步等待大模型摘要。由于单次摘要提炼消耗较长网络时间，会导致 Token 防御触发时的那轮用户交互发生严重的延迟阻塞，被彻底否决。
