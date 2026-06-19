## 改造原因

目前项目根目录下存在一个通用的 `src/utils/` 目录，其中包含 `env.ts`（环境变量处理）、`theme.ts`（终端样式输出）和 `purify.ts`（消息净化过滤）。这种结构属于典型的“垃圾桶 (Garbage Bin)”反模式。
该反模式的存在导致以下架构问题：
1. **职责划分不清晰**：这些文件提供的内容分别属于配置管理、界面视图与底层字符通用工具，混合在同一个顶级目录中削弱了模块物理层级的职责边界。
2. **潜在依赖环与污染**：任何层均可轻易引用顶级 `utils` 目录，极易导致高层领域代码（如 `brain`）由于引用 `utils` 而间接耦合了特定的 UI（如终端 ANSI 颜色控制）或环境配置依赖，增加系统依赖关系的复杂性。
3. **维护性下降**：缺乏明确归属的公共辅助代码会被无节制地塞入此目录，导致其体积和混乱度随开发不断膨胀。

因此，需要在本阶段彻底拆解顶级 `src/utils/` 目录，消除该反模式，以巩固系统层级的纯净边界。

## 变更内容

本变更属于系统架构级的物理重构与职责归位，具体变化如下：
1. **移除顶级 `src/utils/` 目录**。
2. **`env.ts` 职责归位**：将 `src/utils/env.ts` 移动至 `src/config/env.ts`，并归入配置管理子系统。
3. **`theme.ts` 职责归位**：将 `src/utils/theme.ts` 移动至 `src/interface/views/theme.ts`，使其完全属于 UI/视图层。
4. **`purify.ts` 职责归位**：将 `src/utils/purify.ts` 移动至 `src/common/purify.ts`，作为底层无状态字符过滤公共基础设施。
5. **引用链路重构**：更新系统内所有指向这 3 个文件的 `import` 路径，确保应用正常编译及测试通过。

## 业务能力

### 新增业务能力
- 无

### 修改业务能力
- 无

## 影响范围

1. **受到物理移动影响的文件**：
   - `src/utils/env.ts` -> 迁至 `src/config/env.ts`
   - `src/utils/theme.ts` -> 迁至 `src/interface/views/theme.ts`
   - `src/utils/purify.ts` -> 迁至 `src/common/purify.ts`
2. **受到引用路径修改影响的文件**：
   - 依赖 `env.ts` 的模块：`src/config/loader.ts`，`src/interface/commands/model.ts`
   - 依赖 `purify.ts` 的模块：`src/brain/agent-loop.ts`
   - 依赖 `theme.ts` 的模块：`src/index.ts`，`src/config/loader.ts`，`src/interface/command.ts`，`src/interface/facade.ts`，以及 `src/interface/commands/` 目录下的几乎所有指令文件（如 `model.ts` 等），`src/interface/io/input-listener.ts`，`src/interface/views/widget-renderer.ts`
3. **测试用例**：
   - 包含对这几个工具的单元测试，需要调整对应的 `import` 路径以保持测试正常运行。
