## 1. 原生工具契约重构与安全特征自声明

- [x] 1.1 在 `src/action/native-tools/base.ts` 接口中，增加 `readonly securityCategory: 'read' | 'write'` 只读属性。
- [x] 1.2 为 `src/action/native-tools/apply-patch.ts` 原生工具类补充声明 `readonly securityCategory = 'write'`。
- [x] 1.3 为 `src/action/native-tools/directory-manager.ts` 原生工具类补充声明 `readonly securityCategory = 'write'`。
- [x] 1.4 为 `src/action/native-tools/file-system.ts` 中的文件读写工具类分别补充声明 `securityCategory`（读工具为 `'read'`，写/删除工具为 `'write'`）。
- [x] 1.5 为 `src/action/native-tools/git-show-status.ts` 、 `git-show-diff.ts` 、 `git-show-log.ts` 原生工具类分别补充声明 `readonly securityCategory = 'read'`。
- [x] 1.6 为 `src/action/native-tools/read-many-files.ts` 、 `search.ts` 原生工具类分别补充声明 `readonly securityCategory = 'read'`。
- [x] 1.7 为 `src/action/native-tools/terminal.ts` 原生工具类补充声明 `readonly securityCategory = 'write'`。
- [x] 1.8 为 `src/action/native-tools/skill.ts` 原生工具类补充声明 `readonly securityCategory = 'read'`。

<!-- checkpoint: npm run build -->

## 2. 审批流拦截插件解耦与全局常量清洗

- [x] 2.1 修改 `src/brain/plugins/HumanApprovalPlugin.ts`，不再引入全局常量文件 `src/common/constants.ts` 中的 `TERMINAL_ALIASES` 、 `FILE_READ_ALIASES` 、 `FILE_WRITE_ALIASES` 数组。
- [x] 2.2 在引擎层 `src/brain/agent-loop.ts` 实例化 `HookContext` 时，将 `toolRegistry` 引用通过上下文挂载到 `HookContext` 或 `sessionContext` 中，实现依赖注入。
- [x] 2.3 在 `HumanApprovalPlugin` 的 `BeforeTool` 拦截钩子中，从 `context` 动态获取 `ToolRegistry` 实例并匹配待执行工具，读取其 `securityCategory` 属性以判定是写操作（触发 `'suspend'` 挂起确权）还是读操作（执行路径沙箱检查）。
- [x] 2.4 清理 `src/common/constants.ts`，删除多余的硬编码静态拦截别名名单，消除冗余契约。
- [x] 2.5 在 `HumanApprovalPlugin` 中添加兜底安全策略：若工具注册表无法匹配未知或幻觉工具，默认将其类别升格为 `'write'`，强行挂起审批。

<!-- checkpoint: npm run test -->

## 3. 专属算法下沉抽取与领域常量物理闭环重构

- [x] 3.1 分别提取 Unified Diff 块对齐算法、大纲正则提取、文件夹递归复制算法到其同级目录下的独立辅助模块（`apply-patch-helper.ts`, `read-many-files-helper.ts`, `directory-manager-helper.ts`），并对各原生工具主类瘦身。
- [x] 3.2 新建 Action 内部专属常量文件 `src/action/constants/native-tool-names.ts`，将全局 `src/common/constants.ts` 中定义的 17 个内置工具字面量名称彻底迁入其中。
- [x] 3.3 清理全局 `src/common/constants.ts` 中的内置工具字面量名称，消除跨模块命名污染。
- [x] 3.4 替换所有原生工具实现、单元测试和 `HumanApprovalPlugin` 等对内置工具常量的引用，更新导入路径为从 Action 专属常量文件导入。
- [x] 3.5 运行 `npm run lint` 修复一切静态分析报错，以及通过 `npm run test` 和 `npm run test:integration` 保证测试全部通过。

<!-- checkpoint: npm run test:integration -->
