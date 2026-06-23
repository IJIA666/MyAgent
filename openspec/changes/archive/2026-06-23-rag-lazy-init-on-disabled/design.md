## 背景

系统目前在 `AGENT_RAG_ENABLED=false` 禁用 RAG 时，仍会在 `SessionManager` 启动时无条件调用 `MemoryService.rebuildVectorDbIfEmpty()` 以检查向量数据库是否为空并进行重建，由此触发了向量数据库的物理初始化操作。此外，`LongTermMemoryPlugin` 在会话结束触发的提炼任务也未能成功屏蔽，在禁用时造成了不必要的性能和存储访问开销。

## 目标与非目标

**目标:**
- 在配置 `AGENT_RAG_ENABLED=false` 禁用长期记忆 RAG 时，阻止任何对向量库（如 `vectorDb.count()`, `vectorDb.add()`）的非必要逻辑调用。
- 确保在 RAG 禁用时，LanceDB 向量存储服务完全不进行动态 import、文件夹创建、连接和日志打印。
- 确保在 RAG 禁用时，`LongTermMemoryPlugin` 在 `SessionEnd` 生命周期阶段的自省提炼任务完全被跳过，减少多余的 LLM 提炼开销。
- 保证当配置切换为 `AGENT_RAG_ENABLED=true`（启用 RAG）时，数据库的空状态检测和重建服务可以照常运行，实现平滑切换。

**非目标:**
- 不修改底层的 `LocalVectorDbAdapter` 适配器的通用逻辑，保持其作为无状态、职责单一的数据持久层适配器的独立性。
- 不引入复杂的动态生命周期重新注入机制，依旧通过生命周期的钩子在源头上进行静态分支前置判定。

## 架构决策

### 业务与调用源头前置分支拦截（方案 A）
- **实现机制**：
  1. 在 `src/core/usecases/session.ts` 的 `SessionManager` 构造方法中，只有当 `appConfig.runtimeLimits.ragEnabled !== false` 时，才调用并开启 `rebuildVectorDbIfEmpty()` 异步库检查重建。
  2. 在 `src/core/usecases/LongTermMemoryPlugin.ts` 的 `handleSessionEndAsync` 入口处，读取 `appConfig.runtimeLimits.ragEnabled` 的状态，若为 `false`，则直接 `return;` 退出，阻止自省提炼任务的回调激活。
- **选择理由**：
  相较于在 `LocalVectorDbAdapter` 底层做防御性空实现（方案 B），源头过滤的方案能最大化阻断不必要的业务链路，保持软件架构清晰。底层存储适配器不应承载上游的业务开关逻辑，让上游核心服务各司其职，保证了高内聚与职责单一。

## 风险与权衡

### 配置动态切换的边界一致性
- **已知风险**：若长期处于 `ragEnabled=false`，用户在发生多轮对话后，将配置重新修改为 `ragEnabled=true`。由于此前从未使用过 RAG 写入和提炼，重新启用瞬间向量库为空。
- **权衡与自愈策略**：由于 `rebuildVectorDbIfEmpty()` 自身具备空库检测功能（`dbCount === 0 && fileExists` 才会异步重建），一旦配置被改为启用并重启系统，系统便会自动并安全地从 `MEMORY.md` 物理文件中全量读取事实并补充重建向量化索引。这属于良性的配置延迟重建行为，不会产生脑裂或数据丢失风险，且在启动时能自动恢复一致性。
