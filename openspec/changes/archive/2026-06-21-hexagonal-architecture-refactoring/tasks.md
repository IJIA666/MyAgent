## 1. 原地定义薄接口并解耦依赖

- [x] 1.1 全量扫描 6 个子域工具， 对其所有引用 `SessionContext` 的方法进行全量 ` API ` 审计。
- [x] 1.2 在 `src/brain/ports/` 下定义并创建 `SessionEventPort` 薄接口。
- [x] 1.3 在 `src/brain/ports/` 下定义并创建 `TaskAborterPort` 任务中止接口。
- [x] 1.4 在 `src/brain/ports/` 下定义并创建 `ChatUseCase` 核心调用用例接口。
- [x] 1.5 批量重构所有具体工具的 `execute` 方法签名， 将其 `SessionContext` 类型依赖替换为 `SessionEventPort`， 并同步修正测试目录下对应的 `mock` 实例化以防编译阻断。
- [x] 1.6 原地修改 `session.ts`， 将对外围 `BrowserSession` 的直接依赖改为在构造或运行时注入 `TaskAborterPort`。
- [x] 1.7 在 `src/brain/ports/` 下定义并创建 `AgentPlugin` 接口， 并重构插件注册中心 `PluginRegistry` 使其仅面向接口注册和调度具体插件。

<!-- checkpoint: npm run test -->

## 2. 物理迁移目录与物理引用重整

- [x] 2.1 按照六边形规划， 创建 `core/domain`、 `core/usecases`、 `ports/driving`、 `ports/driven`、 `adapters/input`、 `adapters/tools`、 `adapters/plugins` 等物理子目录。
- [x] 2.2 将核心领域实体 `SessionContext` 等文件迁移至 `src/core/domain/` 下。
- [x] 2.3 将核心业务用例 `AgentLoop`、 `PluginRegistry` 等迁移至 `src/core/usecases/` 下.
- [x] 2.4 将 `ChatUseCase` 接口迁移至 `src/ports/driving/`， 将 `LlmPort`、 `SessionEventPort`、 `TaskAborterPort`、 `AgentPlugin` 等接口迁移至 `src/ports/driven/`。
- [x] 2.5 将具体的 LLM 适配器迁移至 `src/adapters/llm/`， 将具体工具适配器迁移至 `src/adapters/tools/`， 将具体插件实现迁移至 `src/adapters/plugins/`。
- [x] 2.6 将 `CliFacade` 及其周边输入代码迁移至 `src/adapters/input/interface/` 下。
- [x] 2.7 全量修复所有被移动文件顶部 `import` 的物理相对路径。

<!-- checkpoint: npm run build -->

## 3. 回归测试验证

- [x] 3.1 运行全量单元测试与集成测试， 确保系统生命周期、 各工具交互行为在六边形重构后仍然完全正常。

<!-- checkpoint: npm run test -->

## 4. 代码质检缺陷修复

- [x] 4.1 **修复 any 报错**： 修复 `src/adapters/tools/tools/browser/browser-action.ts:L78` 中 `any` 显式声明的 ESLint 报错， 替换为强类型的 `unknown` 进行安全属性收敛校验。
