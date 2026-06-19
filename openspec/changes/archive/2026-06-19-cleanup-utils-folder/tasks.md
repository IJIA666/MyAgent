## 1. 基础设施物理移动与首期编译验证

- [x] 1.1 移动 `src/utils/env.ts` 至 `src/config/env.ts`，并依据 JSDoc 规范优化其公开 API 注释（使用标准 TSDoc 移除 `{type}` 声明，并增加文件级 JSDoc 描述）。
- [x] 1.2 移动 `src/utils/theme.ts` 至 `src/interface/views/theme.ts`，并依据 JSDoc 规范优化其公开 API 注释。
- [x] 1.3 移动 `src/utils/purify.ts` 至 `src/common/purify.ts`，并依据 JSDoc 规范优化其公开 API 注释。
- [x] 1.4 重构 `src/config/loader.ts`，彻底移除对 `theme` 模块的导入与高亮调用，配置文件缺失自动生成的提示日志改为普通的纯文本控制台输出，并将对 `env.ts` 的引入路径修正为 `./env.js`。

<!-- checkpoint: npm run build -->

## 2. 核心领域与界面层引用重构

- [x] 2.1 重构 `src/brain/agent-loop.ts`，将其对 `purifyContent` 的导入路径修正为指向 `../common/purify.js`。
- [x] 2.2 重构 `src/index.ts`，将其对 `theme` 的导入路径修正为指向 `./interface/views/theme.js`。
- [x] 2.3 重构 `src/interface/command.ts` 和 `src/interface/facade.ts`，将 `theme` 的导入路径修正为指向 `./views/theme.js`。
- [x] 2.4 重构 `src/interface/io/input-listener.ts` 和 `src/interface/views/widget-renderer.ts`，将 `theme` 的导入路径修正为指向 `./theme.js` 或对应层级。
- [x] 2.5 重构 `src/interface/commands/` 目录下的所有指令源文件（包含 `compact.ts`, `help.ts`, `history.ts`, `mcp.ts`, `model.ts`, `reload-rules.ts`, `resume.ts`, `rollback.ts`, `skill.ts`, `tool.ts`），将其对 `theme` 的导入路径修正为指向 `../views/theme.js`；特别注意 `model.ts` 还需将其导入的 `updateEnvVariable` 指向 `../../config/env.js`。
- [x] 2.6 重构测试用例 `test/brain/purify.test.ts`，将其指向 `../../src/common/purify.js`。
- [x] 2.7 物理删除已经清空的顶级 `src/utils` 目录。

<!-- checkpoint: npm run lint && npm run build -->

## 3. 全局测试运行与规范核实

- [x] 3.1 运行全量单元与集成测试用例，确保 61 项测试全部绿灯通过。
- [x] 3.2 最终执行代码审查，确保所有新增 and 修改的导入完全无 ESM 导入后缀缺失或拼写错误。

<!-- checkpoint: npm run test && npm run test:integration -->
