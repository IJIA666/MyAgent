## 背景

在第一阶段源码层（usecases & driven ports）重构合入后，系统的职责切分非常明确。但在测试层，`test/` 目录下依旧存在 `action/`、`brain/`、`session/` 等扁平历史目录，导致测试代码与源码目录结构失配，违反了整洁架构下“测试与源码目录保持 100% 同构对齐”的规范。
另外，`src/adapters/tools/tools/` 原生工具类实现目录存在尴尬的命名套娃嵌套。
本次变更旨在通过在第二阶段中对测试目录同构重组、套娃命名物理重命名，并修复 Node.js ESM 级联引用破裂问题，使得架构更加整洁与一致。

## 目标与非目标

**目标:**
1. 将 `test/` 顶级目录下除了 `config/`、`integration/`、`scripts/` 外的所有测试文件物理迁移，与 `src/` 建立 1:1 的同构镜像对齐（划分归入 `test/core/usecases/<子域>` 和 `test/adapters/<适配器>`）。
2. 将 `src/adapters/tools/tools/` 物理更名为 `src/adapters/tools/impl/`。
3. 修正所有因上述物理搬迁导致的 ESM 相对路径（带 `.js` 后缀）破裂，使 `npm test` 在重构后保持 100% 绿灯。
4. 将 `test/mock-factory.ts` 移入 `test/helpers/mock-factory.ts`，消除顶级堆积。

**非目标:**
1. 不要在本变更中添加、删除或改动任何已实现的业务逻辑或接口行为（只做纯粹的架构和物理目录重构）。
2. 保持 `test/integration/` 作为系统级端到端集成测试的顶级目录，不做打散重构。
3. 保持 `test/scripts/` 测试构建脚本目录保持不变。
4. 全局测试底座配置 `test/setup.ts` 保持在 `test/` 根目录，不进行挪动。

## 架构决策

1. **分批迭代重构（方案 B）**
   * **决策原因**：重构涉及 30+ 测试文件及内层工具适配器，改动点多且级联引用复杂。我们决定分批推进：
     * **批次一**：套娃更名（`src/adapters/tools/tools` -> `impl`）以及所有适配器测试的搬迁。
     * **批次二**：核心业务用例测试（`brain`, `session` 等）同构搬迁及边缘文件规整。
   * **对比方案**：方案 A 一次性全量迁移。全量搬迁将导致大面积代码爆红，修复相对路径时难以准确定位首个故障点。方案 B 能够通过极其频繁的 `npm test` 快速验证小步变更。
2. **测试层与源码 1:1 同构对齐**
   * **决策原因**：让测试文件完全在物理路径上映射源码的分层和子域。在整洁架构中，这不仅极大地方便了 IDE 快捷跳转，也能最直接地显露出各模块在测试中的依赖合法性，防止测试用例跨域非法导入。
3. **套娃更名为 `impl/`**
   * **决策原因**：外层已是 `adapters/tools/`，内层更名 `impl/` 使其语义明确（表示工具注册适配器底下的具体原生工具实现），消除了冗余嵌套命名，且符合接口与实现的软件工程规范。

## 风险与权衡

1. **ESM 模块后缀（`.js`）路径破裂风险**
   * **风险描述**：在带有 `"type": "module"` 的 Node.js 环境中，相对引用带有 `.js` 强后缀。搬迁测试文件导致它们相对于 `src/` 的深度增加（如从 `../../src` 变成 `../../../../src`），而 IDE 的移动重构功能不会自动替换带有 `.js` 后缀的引入路径，导致 Vitest 报找不到模块错误。
   * **缓解策略**：搬迁后，先使用 Ripgrep 检索各被挪动测试文件的引用破裂，进行细致的手工路径修复；并通过分批提交、分批执行 `npm test` 方式及时校正。
2. **Git 冲突风险**
   * **风险描述**：文件重命名在大规模搬迁中容易因为多人协作或未提交修改导致复杂的 Git 冲突。
   * **缓解策略**：重构前已执行 `git status` 确保工作树绝对干净。建议在独立的分支中一次性高效执行本批次文件移动。

## 详细物理路径迁移映射表

### 批次一：工具与适配器层测试同构 (共 17 个文件)
- **工具类测试 (11 个文件，搬迁至 `test/adapters/tools/`)**
  - `test/action/browser-action-multitenant.test.ts` -> `test/adapters/tools/browser-action-multitenant.test.ts`
  - `test/action/browser-action.test.ts` -> `test/adapters/tools/browser-action.test.ts`
  - `test/action/browser-detector.test.ts` -> `test/adapters/tools/browser-detector.test.ts`
  - `test/action/dangerous-intercept.test.ts` -> `test/adapters/tools/dangerous-intercept.test.ts`
  - `test/action/mcp-client.test.ts` -> `test/adapters/tools/mcp-client.test.ts`
  - `test/action/new-tools.test.ts` -> `test/adapters/tools/new-tools.test.ts`
  - `test/action/safety-and-concurrency.test.ts` -> `test/adapters/tools/safety-and-concurrency.test.ts`
  - `test/action/search.test.ts` -> `test/adapters/tools/search.test.ts`
  - `test/action/terminal.test.ts` -> `test/adapters/tools/terminal.test.ts`
  - `test/action/time.test.ts` -> `test/adapters/tools/time.test.ts`
  - `test/action/tools.test.ts` -> `test/adapters/tools/tools.test.ts`
- **适配器测试 (4 个文件，搬迁至 `test/adapters/<子域>/`)**
  - `test/brain/adapters/OpenAiLlmAdapter.test.ts` -> `test/adapters/llm/OpenAiLlmAdapter.test.ts`
  - `test/brain/adapters/DefaultContextAdapter.test.ts` -> `test/adapters/context/DefaultContextAdapter.test.ts`
  - `test/brain/adapters/JsonVectorDbAdapter.test.ts` -> `test/adapters/vectordb/JsonVectorDbAdapter.test.ts`
  - `test/session/EmbeddingAdapter.test.ts` -> `test/adapters/llm/EmbeddingAdapter.test.ts`
- **输入层测试 (2 个文件，搬迁至 `test/adapters/input/interface/`)**
  - `test/interface/CliFacade.test.ts` -> `test/adapters/input/interface/CliFacade.test.ts`
  - `test/interface/input-listener.test.ts` -> `test/adapters/input/interface/input-listener.test.ts`

### 批次二：核心用例测试同构及边缘辅助文件 (共 16 个文件)
- **安全子域用例测试 (2 个文件，搬迁至 `test/core/usecases/security/`)**
  - `test/brain/ApprovalService.test.ts` -> `test/core/usecases/security/ApprovalService.test.ts`
  - `test/brain/SecurityService.test.ts` -> `test/core/usecases/security/SecurityService.test.ts`
- **公共与全局配置测试 (2 个文件，搬迁至各自同构目录)**
  - `test/brain/purify.test.ts` -> `test/common/purify.test.ts`
  - `test/brain/models.test.ts` -> `test/config/models.test.ts`
- **大脑记忆与事实子域测试 (6 个文件，搬迁至 `test/core/usecases/brain/`)**
  - `test/brain/CompactionService.test.ts` -> `test/core/usecases/brain/CompactionService.test.ts`
  - `test/brain/ContextRepository.test.ts` -> `test/core/usecases/brain/ContextRepository.test.ts`
  - `test/brain/contextLoader.test.ts` -> `test/core/usecases/brain/contextLoader.test.ts`
  - `test/brain/RuleManager.test.ts` -> `test/core/usecases/brain/RuleManager.test.ts`
  - `test/session/prompt.test.ts` -> `test/core/usecases/brain/prompt.test.ts`
  - `test/session/MemoryService.test.ts` -> `test/core/usecases/brain/MemoryService.test.ts`
- **插件子域测试 (1 个文件，搬迁至 `test/core/usecases/plugins/`)**
  - `test/brain/plugins.test.ts` -> `test/core/usecases/plugins/plugins.test.ts`
- **引擎执行子域测试 (3 个文件，搬迁至 `test/core/usecases/engine/`)**
  - `test/brain/ToolDispatcher.test.ts` -> `test/core/usecases/engine/ToolDispatcher.test.ts`
  - `test/session/SessionManager.test.ts` -> `test/core/usecases/engine/SessionManager.test.ts`
  - `test/session/loopback.test.ts` -> `test/core/usecases/engine/loopback.test.ts`
- **核心领域对象测试 (1 个文件，搬迁至 `test/core/domain/`)**
  - `test/brain/context.test.ts` -> `test/core/domain/context.test.ts`
- **测试 Mock 辅助工厂 (1 个文件，搬迁至 `test/helpers/`)**
  - `test/mock-factory.ts` -> `test/helpers/mock-factory.ts`

### 保持原状的顶级文件 (1 个文件)
- `test/setup.ts`：作为测试底座全局配置保持在顶级目录。

