## 改造原因

源码层物理子域解耦（即 `src/core/usecases/` 与 `src/ports/driven/` 下的文件去平铺重组）已基本完成，使得核心业务用例和端口定义具备了清晰的分层。为了保证测试代码的整洁度、防止架构设计的逐渐腐蚀，并降低长期维护心智负荷，急需解决以下问题：
1. **测试目录杂乱与架构失配**：目前 `test/` 顶级目录下依然包含 `action/`、`brain/`、`session/` 等分类，与 `src/` 的核心架构分层出现偏差。在整洁架构最佳实践中，测试目录必须与源目录保持 100% 同构对齐。
2. **命名路径套娃重复**：适配器目录 `src/adapters/tools/tools/` 重复命名嵌套，在代码结构中极显冗余，需将其更名为 `src/adapters/tools/impl/`，终结命名套娃。

## 变更内容

本次变更将对测试代码的物理分布与适配器套娃路径进行全面重构，具体包括：
1. **测试目录 1:1 同构重组**：将 `test/action/`、`test/brain/`、`test/session/` 下的测试用例文件，物理重组划归至 `test/core/usecases/` 或 `test/adapters/` 对应子域同名映射下，使其与 `src/` 完全同构。
2. **套娃路径物理更名**：将 `src/adapters/tools/tools/` 物理更名为 `src/adapters/tools/impl/`。
3. **全局相对路径修复**：由于 Node.js ESM 环境的模块强后缀（`.js`）限制，搬迁后需手工逐个修正所有破裂的相对引用，并重新配置 `package.json` 中的 `npm test` 扫描范围。
4. **边缘与辅助项规整**：将平铺在根目录的 `test/mock-factory.ts` 移入新成立的 `test/helpers/mock-factory.ts`，彻底消除顶级堆积；`test/setup.ts` 保持不变。

## 业务能力

### 新增业务能力
- `test-directory-isomorphism`: 实现测试代码与源目录同构对齐，并终结 tools 适配器路径套娃嵌套，确保 ESM 引用解析和测试质量。

### 修改业务能力

## 影响范围

1. **源文件**：`src/adapters/tools/` 及其子目录下的原生工具引用与加载路径。
2. **测试文件**：整个 `test/` 下的所有 34 个测试文件的存储路径及内部所有 `import ... from ...` 引用路径。
3. **工程脚本**：`package.json` 中的 `scripts.test` 运行命令、`vitest.config.ts` 中的文件扫描路径。
