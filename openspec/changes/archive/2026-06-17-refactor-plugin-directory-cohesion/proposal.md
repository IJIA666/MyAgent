## 改造原因

目前智能体生命周期插件的核心定义（ `plugin-types.ts` ）、注册管理（ `plugin-registry.ts` ）与洋葱执行器（ `plugin-runner.ts` ）均零散平铺在 `src/brain/` 根目录下，这与具体的业务插件实现（ 放置于 `src/brain/plugins/` ）在空间上处于割裂状态，使得 `src/brain/` 根目录文件结构略显杂乱。

为了提升插件模块的内聚性与自治度，并在物理目录层面实现核心流程大循环与具体插件扩展逻辑的彻底解耦，我们迫切需要进行目录层面的整理重构。

## 变更内容

我们将把散落在 `src/brain/` 下的基础设施重构移动至 `src/brain/plugins/` 统一归口：
1.  **基础设施归拢**：将 `plugin-types.ts` 、 `plugin-registry.ts` 和 `plugin-runner.ts` 移入 `src/brain/plugins/` 目录中。
2.  **统一对外网口**：在 `src/brain/plugins/index.ts` 中完成统一的 Barrel 导出。
3.  **引用级联更新**：修改项目中涉及的全部级联导入路径，使外层模块（ 如 `agent-loop.ts` ）及相关测试代码一律仅从 `./plugins/index.js` 统一入口单向引用。
4.  **循环依赖硬防线**：在子模块内强制使用相对路径直接引用，完全杜绝交叉引入导致的运行时 `undefined` 崩溃风险。

## 业务能力

### 新增业务能力
无（ 本次变更属于纯底层的代码目录高内聚物理重构，不涉及新增的业务能力 ）

### 修改业务能力
无（ 本次变更不修改任何业务层的需求规格与功能契约 ）

## 影响范围

- **受影响的代码文件**：
  - [agent-loop.ts](file:///d:/Projects/MyAgent/src/brain/agent-loop.ts)：修改其对插件类型与运行器的导入路径。
  - [session.ts](file:///d:/Projects/MyAgent/src/brain/session.ts)：修改其对插件注册和各具体插件类的引入路径。
  - [plugins.test.ts](file:///d:/Projects/MyAgent/test/brain/plugins.test.ts)：级联更新单元测试文件中的包引入路径。
  - [plugin-runner.ts](file:///d:/Projects/MyAgent/src/brain/plugin-runner.ts) 等插件包内模块的内部导入路径。
- **系统接口**：对外的智能体大循环流程与公共 API 完全不受影响，依然保持极佳的前后向兼容。
