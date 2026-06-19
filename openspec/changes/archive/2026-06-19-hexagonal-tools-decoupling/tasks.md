## 1. 物理结构重构与 Feature 子包划分

- [x] 1.1 在 `src/action/tools/` 目录下创建 `git`、`filesystem`、`system`、`skill` 物理子目录。
- [x] 1.2 重构 `src/brain/services/SecurityService.ts`，在其中增加运行时内存临时路径只读与可写白名单的增删查接口（统一接管原来 base.ts 持有的安全状态）。
- [x] 1.3 将 `src/action/native-tools/base.ts` 移动至 `src/action/tools/base.ts`，清理其持有的临时白名单物理状态，改为向 Brain 层的 `SecurityService` 动态读取白名单，以实现依赖反转。
- [x] 1.4 将 `git-*.ts` 工具及 helper 移入 `src/action/tools/git/` 并在其 `index.ts` 导出内置工具实例。
- [x] 1.5 将文件操作工具（`file-system.ts`, `directory-manager.ts` 等）及 helper 移入 `src/action/tools/filesystem/` 并在其 `index.ts` 导出实例。
- [x] 1.6 将终端相关文件移入 `src/action/tools/system/` 并在其 `index.ts` 导出实例.
- [x] 1.7 将 `skill.ts` 移入 `src/action/tools/skill/` 并在其 `index.ts` 导出实例。
- [x] 1.8 在 `src/action/tools.ts` 中修正导出，在 `virtual-mcp.ts` 中更新工具的批量引入与批量注册逻辑，消除对 18 个扁平工具类的个别静态引用。

<!-- checkpoint: npm run build -->

## 2. 接口契约升级与工具安全自决实现

- [x] 2.1 在 `src/action/virtual-mcp.ts` 的 `NativeTool` 契约定义中追加 `checkSafety(args: Record<string, unknown>, sessionContext?: unknown): Promise<SafetyCheckResult>` 异步接口及 `SafetyCheckResult` 结构定义（包含 `status`, `message`, `safePrefix`, `targetPath` ）。
- [x] 2.2 在终端执行工具 `ExecuteCommandTool` 中实现 `checkSafety`，内聚原本由插件执行的命令危险等级初筛与 YOLO 过滤，并读取 `SecurityService` 获取允许列表。
- [x] 2.3 在文件读写与管理工具（如 `ReadFileTool`, `WriteFileTool`）中实现 `checkSafety`，检测路径是否发生沙箱溢出，读取 `SecurityService` 获取临时路径白名单。
- [x] 2.4 在其他原生工具类（Git 工具、Skill 工具）中补齐 `checkSafety` 默认实现，默认放行 `{ status: 'pass' }`.

<!-- checkpoint: npm run build -->

## 3. 脑网关插件重构解耦与白名单回写

- [x] 3.1 重构 `src/brain/plugins/HumanApprovalPlugin.ts`，彻底移出对 `terminal-config.ts`、`terminal-guard.ts` 以及 Action 层 `base.ts` 的直接物理 `import` 依赖。
- [x] 3.2 在网关拦截前执行向下转型安全反射判定（`'checkSafety' in tool && typeof tool.checkSafety === 'function'`）。若未定义契约方法，则回退判断并启用 Default Deny 兜底，一律强制返回 `suspend` 挂起审批。
- [x] 3.3 在网关的审批回调中，仅调用 Brain 层的 `SecurityService` 写入通过的白名单，斩断对 Action 工具的白名单写入依赖。
- [x] 3.4 清理 `src/action/constants/native-tool-names.ts` 全局类中被淘汰的工具名常量，将常量局限在各工具内部或 Feature 内。

<!-- checkpoint: npm run build && npm run lint -->

## 4. 回归测试与验证

- [x] 4.1 调整测试代码 `test/action/tools.test.ts` 和 `test/action/new-tools.test.ts` 头部具体的 import 引用路径。
- [x] 4.2 调整插件测试中模拟的安全拦截用例，验证新契约与无状态网关行为。
- [x] 4.3 运行全量单元测试与集成测试，验证重构无故障引入。

<!-- checkpoint: npm run test && npm run test:integration -->
