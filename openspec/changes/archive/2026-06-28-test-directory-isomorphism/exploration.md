# 探索主题: 测试层同构与套娃路径更名落地方案

## 1. 问题定义
在源码层（`src/core/usecases` 和 `src/ports/driven`）物理解耦基本完成后，系统架构已进入清晰的子域管理。然而当前系统仍面临两个结构性痛点：
1. **测试层目录套娃与扁平杂乱**：`test/` 顶级目录下依然杂乱平铺着 `action/`、`brain/`、`session/` 等历史目录，与已经按照整洁架构重组的 `src/` 结构出现严重偏差，导致单元测试难以定位，引用关系不直观。
2. **适配器层重复嵌套（套娃）**：`src/adapters/tools/tools/` 目录产生了重复命名嵌套，增加了开发人员的心智负荷，应当更名为更合理的 `src/adapters/tools/impl/`。

本探索旨在为第二阶段 `test-directory-isomorphism` 提供一条无痛迁移、能完美规避 ESM 路径破裂的重构演进方案。

## 2. 关键发现与调研结果
- **代码库现状**：
  - 测试用例目前共有 34 个测试文件，205 个测试用例，且已经全部跑通。
  - 由于 Node.js 的 ESM 运行机制限制，测试文件在引用源码时大都显式指定了 `.js` 后缀的相对路径。物理挪动测试文件将导致这些 `.js` 路径发生破裂。
- **核实与洞察**：
  - 在 ESM 架构下，任何物理文件的移动都必须级联修改其内部的 `import` 引用，同时更新 `vitest.config.ts` 中的测试扫描范围（目前 package.json 脚本中显式声明了具体的测试扫描路径：`vitest run test/brain test/config test/action test/interface test/session`）。

## 3. 方案对比与推荐方向
对于 Phase 2 的落地，我们提供如下两个维度对比方案：

| 评估维度 | 方案 A：一次性全量搬迁 | 方案 B：按子域分批迭代重构 (推荐) | 结论 |
| :--- | :--- | :--- | :--- |
| **单次变更范围** | **大 ✗** | **小 ✓** | B 占优 |
| **编译/测试恢复速度** | **慢 ✗** | **快 ✓** | B 占优 |
| **工作流心智成本** | **低 ✓** | **小 ✗** | A 占优 |

**推荐路径**：
选择 **方案 B**。我们将通过 `/openspec-propose test-directory-isomorphism` 启动此阶段变更，并将其拆解为如下两批次推进：
- **批次一**：套娃重构与适配器测试对齐。
  1. 重命名 `src/adapters/tools/tools/` 为 `src/adapters/tools/impl/`。
  2. 搬迁 `test/action/` 下的所有工具测试文件至 `test/adapters/tools/`，并搬迁 `test/brain/adapters/` 与 `test/session/` 下的适配器测试至对应 `test/adapters/` 同构目录。
- **批次二**：核心用例测试镜像同构对齐。
  1. 搬迁 `test/brain/` 和 `test/session/` 中的其余用例测试到 `test/core/usecases/` 下的 `brain/`、`plugins/`、`engine/`、`security/` 各自子域。
  2. 搬迁 `test/mock-factory.ts` 到 `test/helpers/mock-factory.ts`。
  3. 更新 `package.json` 中的测试运行脚本及 `vitest.config.ts`。

### 📌 详细物理路径迁移映射表

| 原始测试路径 | 目标测试路径 | 关联源码文件 |
| :--- | :--- | :--- |
| `test/brain/contextLoader.test.ts` | `test/core/usecases/brain/contextLoader.test.ts` | `src/core/usecases/brain/contextLoader.ts` |
| `test/brain/RuleManager.test.ts` | `test/core/usecases/brain/RuleManager.test.ts` | `src/core/usecases/brain/RuleManager.ts` |
| `test/brain/CompactionService.test.ts` | `test/core/usecases/brain/CompactionService.test.ts` | `src/core/usecases/brain/CompactionService.ts` |
| `test/brain/ContextRepository.test.ts` | `test/core/usecases/brain/ContextRepository.test.ts` | `src/core/usecases/brain/ContextRepository.ts` |
| `test/brain/plugins.test.ts` | `test/core/usecases/plugins/plugins.test.ts` | `src/core/usecases/plugins/` (多个文件) |
| `test/brain/ApprovalService.test.ts` | `test/core/usecases/security/ApprovalService.test.ts` | `src/core/usecases/security/ApprovalService.ts` |
| `test/brain/SecurityService.test.ts` | `test/core/usecases/security/SecurityService.test.ts` | `src/core/usecases/security/SecurityService.ts` |
| `test/brain/ToolDispatcher.test.ts` | `test/core/usecases/engine/ToolDispatcher.test.ts` | `src/core/usecases/engine/ToolDispatcher.ts` |
| `test/session/MemoryService.test.ts` | `test/core/usecases/brain/MemoryService.test.ts` | `src/core/usecases/brain/MemoryService.ts` |
| `test/session/SessionManager.test.ts` | `test/core/usecases/engine/SessionManager.test.ts` | `src/core/usecases/engine/session.ts` |
| `test/session/loopback.test.ts` | `test/core/usecases/engine/loopback.test.ts` | 核心引擎与回环机制 |
| `test/session/prompt.test.ts` | `test/core/usecases/brain/prompt.test.ts` | `src/core/usecases/brain/prompts.ts` |
| `test/action/*` (11个工具类文件) | `test/adapters/tools/*` | `src/adapters/tools/` 基础设施工具 |
| `test/brain/adapters/OpenAiLlmAdapter.test.ts` | `test/adapters/llm/OpenAiLlmAdapter.test.ts` | `src/adapters/llm/OpenAiLlmAdapter.ts` |
| `test/brain/adapters/DefaultContextAdapter.test.ts` | `test/adapters/context/DefaultContextAdapter.test.ts` | `src/adapters/context/DefaultContextAdapter.ts` |
| `test/brain/adapters/JsonVectorDbAdapter.test.ts` | `test/adapters/vectordb/JsonVectorDbAdapter.test.ts` | `src/adapters/vectordb/JsonVectorDbAdapter.ts` |
| `test/session/EmbeddingAdapter.test.ts` | `test/adapters/llm/EmbeddingAdapter.test.ts` | `src/adapters/llm/` 向量适配器 |
| `test/mock-factory.ts` | `test/helpers/mock-factory.ts` | 测试用 Mock 辅助工厂 |

## 4. 约束、风险与未知项
- **ESM `.js` 后缀的修改精度**：
  在移动文件后，IDE 不会自动处理 Node.js 的 ESM `.js` 强后缀相对引用。必须使用全局搜索与细致检查，并借助 `npm test` 来保证所有迁移的文件不会因为模块解析失败而挂掉。
- **Git 追踪与冲突风险**：
  在大大规模文件搬迁期间，应尽量避免并行对被挪动文件进行大改，防止 Git 发生复杂的追踪丢失冲突。

## 5. 否决方案
- **一次性全量改动所有引用且不执行分步验证**：已被否决。因为多达 30+ 测试文件及几十个被挪动源码的交叉引用，极易发生拼写或路径级联计算错误，全量报错会导致极难排查根因。
