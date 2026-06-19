## 背景

项目目前将环境变量热更新（`env.ts`）、终端样式防腐（`theme.ts`）和日志净化过滤（`purify.ts`）统一放置在顶级 `src/utils/` 目录下。这违反了清洁架构（Clean Architecture）的职责单一原则：
- 配置管理的写操作（修改 `.env`）属于系统启动及配置维护的基础设施。
- 终端着色样式（`theme.ts`）是 UI 展现的专有细节，核心大脑与配置加载器本不应直接对此产生依赖。
- 日志净化（`purify.ts`）则是日志落盘审计的纯数据无状态转换操作。

当前，所有模块通过顶级 `src/utils/` 进行全向调用，造成了依赖结构的混杂与潜在的循环依赖风险。

## 目标与非目标

**目标:**
- 物理拆除顶级 `src/utils/` 目录，将现有的 3 个文件（`env.ts`、`theme.ts`、`purify.ts`）迁移至对应的职责目录。
- 彻底解除底层配置模块 `src/config/loader.ts` 对 UI 呈现层 `theme.ts` 的逆向跨层依赖，仅使用无格式纯文本控制台输出，以严格遵守依赖倒置原则（DIP）。
- 重构全系统所有的引用路径，保证重构后系统能成功通过 Lint 静态检查。
- 重构所有受影响的单元测试，确保全系统 61 项单元与集成测试 100% 通过。
- 保证 `process.env` 的直接读取和写入操作完全收敛在 `src/config/`，其它业务层继续遵守 `config-physical-blockade` 规约。

**非目标:**
- 本次重构坚决不增加任何新的业务逻辑或面向用户的新功能。
- 坚决不修改这 3 个文件的核心业务逻辑，仅对其物理路径和 JSDoc 格式进行规范化调整。
- 坚决不在大脑（`src/brain/`）中再次衍生局部的 `utils` 目录，以防造成领域层二次污染。

## 架构决策

1. **`env.ts` 归入配置管理**：
   - 决策：将 `src/utils/env.ts` 移至 `src/config/env.ts`。
   - 理由：`env.ts` 承载了 `.env` 的非破坏性正则更新、必填校验与插值替换，这与配置加载（`loader.ts`）高度内聚，同属于配置管理子系统。
2. **`theme.ts` 下沉至视图层**：
   - 决策：将 `src/utils/theme.ts` 移至 `src/interface/views/theme.ts`。
   - 理由：ANSI 终端着色完全是 CLI 视图呈现的实现细节。将其划归为 UI 展现层符合 Clean Architecture 职责划分，阻止了 Domain 层向 UI 层的依赖溢出。
3. **`purify.ts` 移入通用基建**：
   - 决策：将 `src/utils/purify.ts` 移至 `src/common/purify.ts`。
   - 理由：`purify.ts` 中的 `purifyContent` 属于无状态、无副作用的纯文本转换函数，且不依赖任何其它模块。放置于 `src/common/` 目录下（与 `constants.ts` 扁平并列）能作为系统最底层的通用纯函数，既方便被 `agent-loop.ts` 引用，又从根本上避免了在领域层内建局部 utils 带来的次级污染。
4. **解除配置层对视图层的逆向依赖**：
   - 决策：彻底移除 `src/config/loader.ts` 对 `theme` 模块的引用，将其配置文件缺失自动生成的提示改为无样式的纯文本控制台输出。
   - 理由：`src/config/` 作为系统配置加载与引导底层，绝对不应反向依赖作为外层 UI 展现细节的 `theme`（位于 `src/interface/views/`）。此决策维护了清洁架构中由外向内的依赖规则，避免了逆向跨层依赖。

## 风险与权衡

- **[引用链广泛，修改容易遗漏]** -> 缓解策略：利用 `grep_search` 锁定了所有 16 个依赖导入文件，在重构后，强制运行一次全量编译与 `npm run lint`，并通过 ESLint 静态分析拦截任何死引用或无法解析的模块路径。
- **[ESM 格式的后缀解析问题]** -> 缓解策略：本项目基于 ESM（`"type": "module"`），在修改 `import` 路径时，必须确保所有相对路径的导入均带有正确的 `.js` 后缀，如 `import { theme } from '../../views/theme.js'`。
