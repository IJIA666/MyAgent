# 探索主题: RAG禁用时向量库过度初始化问题

## 1. 问题定义
在系统配置 `AGENT_RAG_ENABLED=false` 时，尽管对话中的 RAG 召回已被停用，但系统启动阶段依然会打印 `[LocalVectorDbAdapter] 成功加载并建立本地 LanceDB 向量存储服务。` 日志。这说明在关闭长期记忆 RAG 后，系统仍然初始化并连接了底层 LanceDB 向量数据库，不仅引起了用户的使用误解，也造成了不必要的系统内存与计算资源开销。

## 2. 关键发现与调研结果
- **代码库现状**：
  1. `SessionManager` 构造函数末尾会无条件异步调用 `MemoryService.rebuildVectorDbIfEmpty()` 确保物理记忆文件重建，该逻辑内部调用了 `vectorDb.count()`。
  2. `LocalVectorDbAdapter` 在被调用 `count()`、`search()` 等任何方法时，会触发 `ensureInitialized()`，从而导致 LanceDB 的物理加载 `lancedb.connect()` 和日志输出。
  3. `LongTermMemoryPlugin` 在 `SessionEnd` 钩子中，只计算了有效对话轮数并触发提炼，没有对 `ragEnabled === false` 做出拦截限制，这就意味着会话结束时仍可能发生提炼和保存逻辑。
- **核实与洞察**：
  根据对 LanceDB SDK 的核实，虽然 LanceDB 内部的 `openTable` 本身是惰性加载数据（不会全量载入内存），但在连接建立时，底层 Rust 绑定仍会执行物理加载和目录锁定。在 RAG 被明确禁用的场景下，不应当调用任何涉及 `vectorDb` 的底层查询与初始化，以实现最大化的“按需零开销”。

## 3. 方案对比与推荐方向
| 评估维度 | 方案 A：上游业务级按需拦截（推荐） | 方案 B：数据库适配器内部防御性空实现 | 结论 |
| :--- | :--- | :--- | :--- |
| **开销与日志控制** | 优秀 ✓：完全阻止了对向量库的所有调用和连接，内存和初始化耗时为零。 | 良好：适配器内做空实现，但如果上游仍发起调用，可能掩盖设计逻辑缺陷。 | 方案 A 占优 |
| **逻辑侵入性** | 中等：需要在 `SessionManager` 重建和 `LongTermMemoryPlugin` 钩子中进行前置校验。 | 极低：仅在 `LocalVectorDbAdapter` 内部根据配置决定是否直接返回 Mock 空数据。 | 方案 B 占优 |
| **代码可维护性** | 优秀 ✓：调用链路清晰，组件根据配置各司其职，禁用时就应当彻底阻断关联链路。 | 较差：让底层存储适配器去承载业务开关逻辑，混合了职责，增加心智负担。 | 方案 A 占优 |

**推荐路径**：
采纳 **方案 A**。在调用源头进行严格的 `ragEnabled === false` 校验，从业务层切断数据库调用，具体包括：
1. 在 `SessionManager` 构造中，仅在 `appConfig.runtimeLimits.ragEnabled !== false` 时发起 `rebuildVectorDbIfEmpty()` 异步任务。
2. 在 `LongTermMemoryPlugin` 两个核心钩子 `BeforeModel` 和 `SessionEnd` 开头均加入 `ragEnabled === false` 校验并提前退出。

## 4. 约束、风险与未知项
- **测试用例兼容性**：原有单元测试在 RAG 启闭时有针对 `BeforeModel` 和 `SessionEnd` 行为的断言，需要保证测试环境的 `AppConfig` 具有合理的 Mock 值（目前 `test/mock-factory.ts` 中已有对应的默认值，能够支持平滑验证）。
- **配置切换边界行为**：若未来有人将 RAG 从禁用（`ragEnabled=false`）改为启用（`ragEnabled=true`），由于此前从未执行过 `rebuildVectorDbIfEmpty()` 异步重建，向量库在重新启用瞬间可能为空，但 `rebuildVectorDbIfEmpty()` 自身的 `count() === 0 && fileExists` 检测会被自动触发，使得系统能自动且安全地在下一次启动时补全向量数据，因此这属于良性的延迟重建行为。

## 5. 否决方案
- **方案 B（适配器内部空实现）**：因混淆了存储组件和业务逻辑，并可能导致排查调试时难以理清数据库适配器是否真实连接，故予以否决。
