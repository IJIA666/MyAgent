## 1. 基础常量与基底路径改造

- [x] 1.1 在 `src/common/constants.ts` 中新增扩展原生工具的常数名标识。
- [x] 1.2 在 `src/action/native-tools/base.ts` 优化与补强跨操作系统的通用工作区沙箱路径越权判定逻辑。

<!-- checkpoint: npm run build -->

## 2. 结构化目录与路径管理工具开发

- [x] 2.1 新增 `CreateDirectoryTool` 工具，底层调用 `fs.mkdirSync` 原生递归创建多级文件夹。
- [x] 2.2 新增 `DeletePathTool` 工具，实现工作区沙箱路径强制校验与对接底座 `ApprovalService` 确权挂起拦截流程。
- [x] 2.3 新增 `MovePathTool` 与 `CopyPathTool` 工具，原生实现文件/目录的复制与转移，彻底磨平平台命令差异。

<!-- checkpoint: npm run build -->

## 3. 批量多文件读取与补丁修补工具开发

- [x] 3.1 新增 `ReadManyFilesTool` 工具，实现多相对路径并行拉取，内置体积熔断（ 50,000 字符限制 ），且拒签时采用轻量级正则匹配大纲（ 无法正则的则降级首尾 20 行 ）的极速响应机制。
- [x] 3.2 新增 `ApplyPatchTool` 工具，实行严格 Diff 补丁修补以及基于期望上下文签名（ expectedContent ）滑动窗口特征对齐定位的块替换双轨控制。

<!-- checkpoint: npm run build -->

## 4. 只读 Git 辅助信息拉取工具开发

- [x] 4.1 新增 `GitShowStatusTool` 工具，原生抓取 Git status 变化相对路径并包装为结构化 JSON 返回。
- [x] 4.2 新增 `GitShowDiffTool` 工具，只读拉取增量 Diff 结果并过滤 ANSI 颜色标记。
- [x] 4.3 新增 `GitShowLogTool` 工具，只读拉取最近 commit 日志汇总，用于大模型梳理代码库重构脉络。

<!-- checkpoint: npm run build -->

## 5. 底座凭证总线控制与虚拟服务器注册集成

- [x] 5.1 在虚拟服务器 `src/action/virtual-mcp.ts` 注册这 9 个新增的原生工具实例。
- [x] 5.2 实施高危删除工具与底座 `ApprovalService` 的联动调试，确认 REPL 层 InputListener 键盘流关闭与重启事件时机无冲突，并跑通全流程单元测试。

<!-- checkpoint: npm run test -->

## 6. 修复原生 Lint 静态分析工具的报告报错

- [x] 6.1 修复 ESLint 关于 `any` 类型的警告：将所有的 `sessionContext?: any` 替换为 `sessionContext?: unknown`，并修改相关强制类型转换。
- [x] 6.2 修复未使用的参数报错：将 `sessionContext` 替换为 `_sessionContext`，将未用到的 `args` 替换为 `_args`，并移除测试文件中未使用的 `vi`。
- [x] 6.3 修复控制字符正则表达式报错：使用 `new RegExp(...)` 方式动态构造 ANSI 颜色过滤正则，规避直接字面量控制字符报错。
- [x] 6.4 修复 `preserve-caught-error` 报错：在 throw Error 时附加原始 error 到 `cause` 字段中。
- [x] 6.5 修复 `no-useless-assignment` 错误：调整 `read-many-files.ts` 中 `paths` 变量的声明与初始化逻辑。
- [x] 6.6 清理 `constants.ts` 中不规范的“新增：”注释前缀，还原为客观简洁的属性声明注释。

<!-- checkpoint: npm run lint -->
