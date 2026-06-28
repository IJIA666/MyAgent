# 探索主题: 全局源目录与测试目录的职责对齐及微观解耦

## 1. 问题定义
当前代码库存在三级明显的物理目录结构散乱痛点：
1. **用例层过度平铺**：`src/core/usecases/` 目录下平铺了 22 个文件，职责混乱（涵盖生命周期、 ReAct 执行核心、智能体脑事实配置以及 9 个拦截插件）。
2. **端口层过度平铺**：`src/ports/driven/` 目录下平铺了 13 个接口文件，随着系统演进，缺少对大模型、工具、会话和数据库等出口契约的微观域划分。
3. **测试层目录映射错乱**：`test/` 顶级结构与 `src/` 不存在 1:1 镜像关系，使用了 `brain/`、`action/`、`session/` 等模糊的大杂烩分类，导致适配器和用例的测试文件分布极不直观，维护成本高昂。

## 2. 关键发现与调研结果
- **代码库现状**：
  - `src/core/usecases/` 下堆积了 22 个 TS 用例/插件文件，没有做子领域隔离。
  - `src/ports/driven/` 下堆积了 13 个契约接口，未做领域隔离。
  - `test/` 下只有 `action/`、`brain/`、`session/` 等分类，与 `src/` 的核心分层（`core/`、`ports/`、`adapters/`）严重偏离。
- **核实与洞察**：
  - 在整洁架构（Clean Architecture）最佳实践中，测试目录应与源目录保持 **100% 同构 (Isomorphic Directory Structure)**，这不仅方便 IDE 进行同名测试关联跳转，更有助于以黑盒/白盒物理分布反向核实分层依赖关系（防止测试用例越权引用）。

## 3. 方案对比与推荐方向
| 评估维度 | 方案 A：双向同构对齐与子域解耦 (推荐) | 方案 B：仅重构 usecases 源码，保持 test 平铺 | 选型分析 |
| :--- | :--- | :--- | :--- |
| **可维护性与心智负荷** | **极佳 ✓**：源文件与测试文件完全镜像，且 usecases/ports 下各子域高内聚。 | **中 ✗**：usecases 有改善，但测试和接口的位置依然极难定位。 | 方案 A 占优 |
| **架构演进一致性** | **强 ✓**：100% 对齐标准的六边形架构，新环境极其友好。 | **弱 ✗**：测试与源码使用两套分类语境，增加架构冲突。 | 方案 A 占优 |
| **重构相对路径修改量** | **较大 ✗**：涉及源文件、单元测试物理搬迁及大量 import 改写。 | **中 ✓**：变动仅限于 `src/core/usecases` 内部。 | 方案 B 占优 |

**推荐路径**：
**方案 A**。分两阶段推进：
- **阶段一**：将 `src/core/usecases/` 下的 22 个文件按职责彻底划分为 `plugins/`（插件）、`engine/`（核心循环）、`brain/`（记忆与事实）、`security/`（安全防护）四个子域文件夹。
- **阶段二**：将 `src/ports/driven/` 下的 13 个接口文件，划分归入对应的子域文件夹。
- **阶段三**：将整个 `test/` 目录进行 1:1 重构对齐，分为 `test/core/`（镜像 usecases 四大子域）与 `test/adapters/`（镜像 llm/tools/vectordb 适配器），彻底终结“brain/action/session”这种凌乱的分类。

---

### 🎨 阶段一与阶段二详细规划

#### 1. 用例层拆分 (`src/core/usecases/` 22个文件)
* **`plugins/` (插件，9个文件)**: `HumanApprovalPlugin.ts`、`JitRulesPlugin.ts`、`LongTermMemoryPlugin.ts`、`LoopPreventionPlugin.ts`、`TokenWatermarkPlugin.ts`、`TracerLogPlugin.ts`，及 `plugin-registry.ts`、`plugin-runner.ts`、`plugin-types.ts`。
* **`engine/` (引擎执行，4个文件)**: `agent-loop.ts`、`session.ts`、`ToolDispatcher.ts`、`LifecycleManager.ts`。
* **`brain/` (大脑记忆事实，6个文件)**: `MemoryService.ts`、`RuleManager.ts`、`prompts.ts`、`ContextRepository.ts`、`contextLoader.ts`、`CompactionService.ts`。
* **`security/` (审批与安全，3个文件)**: `SecurityService.ts`、`ApprovalService.ts`、`FileLockManager.ts`。

#### 2. 端口层拆分 (`src/ports/driven/` 13个文件)
* **`llm/` (大模型与估算，3个文件)**: `LlmPort.ts`、`EmbeddingPort.ts`、`TokenEstimatorPort.ts`。
* **`db/` (存储库，1个文件)**: `VectorDbPort.ts`。
* **`tools/` (工具与强杀，4个文件)**: `AgentPlugin.ts`、`ToolRegistryPort.ts`、`McpManagerPort.ts`、`TaskAborterPort.ts`。
* **`session/` (生命周期、会话与人机审批，4个文件)**: `SessionEventPort.ts`、`EventNotificationPort.ts`、`ContextAdapter.ts`、`ApprovalPort.ts`（审批作为会话流的事件控制，归入此域更合理）。
* **`security/` (纯安全质检，1个文件)**: `QualityCheckPort.ts`。

#### 3. 工具适配器“套娃”路径重构 (`src/adapters/tools/tools/` -> `impl/`)
* **痛点**：外层 `adapters/tools` 包含工具注册与 MCP 客户端等基础设施适配器，内层 `tools/tools/` 包含具体原生工具类实现，产生尴尬的 `tools/tools` 重复套娃路径。
* **整改方案**：将内层 `tools/tools/` 物理更名为更专业的具体实现目录：如 `impl/`（或者 `natives/`、`implementations/`），终结命名套娃。

#### 4. 阶段三测试目录同构重组与边缘项归宿
在实施 `test/` 与 `src/` 的 1:1 同构对齐时，测试目录下的非镜像及边缘项应按如下规范进行物理划分：
- **镜像对齐项**：`test/action/`、`test/brain/`、`test/session/` 下的测试用例文件，物理重组划归至 `test/core/usecases/` 或 `test/adapters/` 对应同名映射下。
- **`test/config/`**：完全对齐 `src/config/`，保持与源目录一致的 1:1 同构映射。
- **`test/integration/`**：保留作为系统级端到端集成测试的专门顶级目录，不做打散。
- **`test/scripts/`**：保留作为测试构建脚本的辅助目录，不做变更。
- **`test/mock-factory.ts`**：移入新成立的测试辅助目录 `test/helpers/mock-factory.ts`，消除顶级堆积。
- **`test/setup.ts`**：作为测试底座的全局配置不变量，继续保留在 `test/` 根下。

## 5. 约束、风险与未知项
- **路径重置成本（Node.js ESM 特异性风险）**：物理移动文件会导致大量的 `import ... from ...` 路径发生破裂。
  - **⚠️ 关键风险**：在项目带有 `"type": "module"` 的 Node.js ESM 环境下，大部分 import 语句带有强硬的 `.js` 后缀（如 `from './prompts.js'`）。**VSCode 等 IDE 的自动重构移动并不会自动修改或重定向带有 `.js` 后缀的相对引入路径**，极易导致大面积编译与执行期找不到模块报错。
  - **缓解策略**：在文件移动完毕后，必须使用全局 `grep` (或 Ripgrep) 检索被移动文件名在全局源文件和单测中的出现，逐个手工校对并人工终审 `.js` 级联破裂引用；并通过分批 propose 逐步迁移，每次配合 Checkpoint `npm test` 保证全绿。
- **LanceDB 与向量库持久化路径**：移动文件不得改变 `appConfig.workspace` 相对定位中的运行期数据库路径。

## 5. 否决方案
- **保持 test 大杂烩，只拆 src**：该方案被否决。因为它仅解决了半边问题，开发人员依然会在 `test/` 下乱塞文件，测试环境的混乱会很快反向腐蚀源码的设计纯净度。
