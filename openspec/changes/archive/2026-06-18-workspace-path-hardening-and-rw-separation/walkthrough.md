# 物理路径加固与读写隔离变更验收

当前变更已成功实施并通过全量单元测试验证。以下为实施的改动及验证结果总结：

## 修改文件列表

- **[NEW] [constants.ts](file:///d:/Projects/MyAgent/src/common/constants.ts)**
  - 遵循常量文件的最佳工程实践，设立了全局 `common` 通用模块，在 `src/common/constants.ts` 中独立定义了 `ToolConstants` 静态常量类管理所有契约标识，解除了高阶模块插件（`brain`）与底层工具实现（`action`）的深层交叉耦合依赖。
- **[base.ts](file:///d:/Projects/MyAgent/src/action/native-tools/base.ts)**
  - 移除了原有的 `ToolConstants` 类。
  - **恢复了文件最顶部的模块级文件 JSDoc 注释**，使其作为一个纯函数模块完全符合 JSDoc 与 IDE 智能提示排版规范的要求。
  - 修复了第 38 行不必要的正则斜杠转义字符，消除了 ESLint `no-useless-escape` 报错。
- **[virtual-mcp.ts](file:///d:/Projects/MyAgent/src/action/virtual-mcp.ts)**
  - 调整导入路径，直接从 `../common/constants.js` 中引入 `ToolConstants` 常量类。
  - 在 `LocalFileSystemMcpServer.callTool` 路由中，使用 `ToolConstants` 静态属性替换了原先的魔法字符串 case 匹配。
- **[HumanApprovalPlugin.ts](file:///d:/Projects/MyAgent/src/brain/plugins/HumanApprovalPlugin.ts)**
  - 调整导入路径，直接从 `../../common/constants.js` 中引入 `ToolConstants` 常量类。
  - 修复了 `hasAuth` 与 `accessType` 声明时无用的初值赋值逻辑，消除了 ESLint `no-useless-assignment` 错误。
  - 在 `BeforeTool` 生命周期钩子中，针对终端执行工具以及文件读取/写入工具进行了重构。
  - 升级了 `service.wait` 的调用方式，并在传入 `safePrefix` 处通过空值合并 `?? undefined` 修复了参数可能为 `null` 导致的 TS2345 编译错误。
  - 废弃了对具体工具名称的单一硬编码比对，升级为更具扩展性的特征能力集 `.includes(...)` 比对（如 `TERMINAL_TOOL_NAMES`, `FILE_READ_TOOL_NAMES`, `FILE_WRITE_TOOL_NAMES`），彻底解决由于大小写或命名错配导致安全卡关被绕过的隐患。
  - 新增了详细的行级注释，符合注释规范要求。
- **[ApprovalService.ts](file:///d:/Projects/MyAgent/src/brain/services/ApprovalService.ts)**
  - 新增了 `registerApprovalHandler` 方法，支持外层 CLI 注册实时交互回调，绕过 Generator 原地挂起时的事件流截断限制。
  - 升级了 `wait` 接口，支持传入工具元数据，并消开了 `any` 显式类型，使用严格的 `Record<string, unknown>`，消除 ESLint `no-explicit-any` 报错。
- **[facade.ts](file:///d:/Projects/MyAgent/src/interface/facade.ts)**
  - 构造函数中向 `session.approvalService` 注册了卡关回调提问处理器，实现同步且非阻塞的终端交互界面渲染，完美破解了底层 Generator 死锁问题。
  - 移除了解决审批后多余的 `this.listener.resume()`，防止生成大循环未结束前提前打印提示符导致次序错乱与越权并发监听。
  - 重构了常规对话处理分支（`handleLineSubmit`），引入与斜杠指令对齐的 `try-finally` 结构，在进入大循环前执行 `pause()`，在完工后统一 `resume()`，彻底杜绝了用户在生成期间乱敲回车导致的忙锁崩溃。
  - 在 `runStreamLoop` 中将 `case 'suspend'` 拦截过滤并作为 no-op break，防止已由回调处理过的事件发生二次终端弹窗骚扰。
- **[input-listener.ts](file:///d:/Projects/MyAgent/src/interface/io/input-listener.ts)**
  - 引入了 `isPaused` 私有状态标志位，并在 `pause()`、`resume()` 以及 `start()` 中完成了状态在生命周期内的同步维护。
  - 重构了 `'line'` 事件处理器，增加了 `isPaused` 阻断判断，在输入挂起期间物理丢弃由于多路 Readline 共用底层 Stdin 流被意外唤醒而派发的所有残留回车，彻底杜绝了人机审批卡关解锁后意外并发触发 `handleLineSubmit` 引发 context 忙锁崩溃的问题。

## 验证与测试结果

### 静态规范检查
- **命令**：`npm run lint`
- **结果**：ESLint 校验完全通过，项目代码无任何格式或风格报错（Eslint Clean）。

### 自动编译检查
- **命令**：`npm run build`
- **结果**：全量 TypeScript 静态类型编译通过，无任何编译及类型导入警告。

### 自动化单元测试
- **命令**：`npm run test`
- **结果**：本地执行全量测试套件成功，共 8 个测试文件（Test Files）、42 个测试用例（Tests）全部通过。
