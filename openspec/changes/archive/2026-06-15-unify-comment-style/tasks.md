## 1. 核心 Brain 模块注释重构

- [x] 1.1 重构 `src/brain/context.ts`：规范类与方法的 TSDoc 文档注释，移除冗余类型注解，格式化行内注释。
- [x] 1.2 重构 `src/brain/TokenEstimator.ts`：规范类与方法的 TSDoc 文档注释，移除冗余类型注解，格式化行内注释。
- [x] 1.3 重构 `src/brain/agent-loop.ts`：规范类与方法的 TSDoc 文档注释，移除冗余类型注解，格式化行内注释。
- [x] 1.4 重构 `src/brain/driver.ts`、`src/brain/session.ts`、`src/brain/tracer.ts`、`src/brain/prompts.ts`、`src/brain/contextLoader.ts` 等文件。
- [x] 1.5 重构 `src/brain/adapters/` 与 `src/brain/services/` 目录下的子模块文件。

<!-- checkpoint: npm run build -->

## 2. 外围逻辑模块注释重构

- [x] 2.1 重构 `src/action/` 目录下的所有源文件：规范化导出的 API 与内部行内注释。
- [x] 2.2 重构 `src/config/` 目录下的所有源文件：规范化导出的 API 与内部行内注释。
- [x] 2.3 重构 `src/interface/` 目录下的所有源文件：规范化导出的 API 与内部行内注释。
- [x] 2.4 重构 `src/utils/` 目录下的所有源文件及根目录下的 `src/index.ts`。

<!-- checkpoint: npm run build -->

## 3. 静态检查与验证

- [x] 3.1 运行项目的 lint 规则，验证是否有语法警告。
- [x] 3.2 运行全部单元测试，确保系统既有行为未受重构影响。

<!-- checkpoint: npm run test -->
