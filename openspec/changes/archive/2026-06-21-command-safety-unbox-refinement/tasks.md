## 1. 终端安全拦截核心算法改进

- [x] 1.1 编写 `getMatchingQuoteIndex(str)` 辅助函数（作为 1.4 引号配对校验的前置依赖），扫描首字符引号在字符串内成对闭合且未被反斜杠转义的匹配索引。
- [x] 1.2 重构 `unboxNestedCommand` 函数框架（与 1.3、1.4 共同组成函数改造整体）。移除 `while` 循环外的第一次 `stripLeadingEnvAssignments` 冗余调用，完全收拢至循环体内部流转。
- [x] 1.3 升级 `unboxNestedCommand` 中的 `shellPrefixPattern` 正则以匹配并忽略解释器与 `-Command` 之间的其他 CLI 参数选项（如 `-ExecutionPolicy Bypass`），并添加 `env` 兼容 Git Bash 模拟终端的注释说明。
- [x] 1.4 在 `unboxNestedCommand` 中引入“切片剥壳法”（结合 1.1 辅助工具）。定位外壳结束后利用 `slice` 截取全部剩余内容作为内层命令以防嵌套引号截断；基于 `getMatchingQuoteIndex` 校验最外层引号配对是否完美包裹，避免多组引号误删；最后通过 `if (/^&\s*\{/.test(innerCmd) && innerCmd.endsWith('}'))` 精确识别并清洗 PowerShell 匿名脚本包裹块。

<!-- checkpoint: npm run build -->

## 2. 配置文件初始化与前缀剥壳提取

- [x] 2.1 重构 `loadAllowedCommands`，在加载配置时，如果检测到磁盘上 `.agent/allowed_commands.json` 文件不存在或为空，系统自动通过 `saveAllowedCommands` 在本地写入预设白名单（含 `git status:*` 等常用规则）进行初始化。
- [x] 2.2 修改 `extractSafePrefix`，在对命令进行 Root 与 Sub 拆分之前，先调用 `unboxNestedCommand` 对原始指令剥壳，提取内核命令前缀以实现通用化。

<!-- checkpoint: npm run build -->

## 3. 安全校验剥壳匹配与知情告知信息融合

- [x] 3.1 修改 `ExecuteCommandTool.checkSafety`，在 Auto 模式匹配白名单时，对待校验命令先调用 `unboxNestedCommand(command).trim()` 进行解包剥壳，再与白名单规则进行匹配。
- [x] 3.2 修改 `ExecuteCommandTool.checkSafety` 在 `needApproval` 挂起审批时的返回逻辑。若解包剥壳后的核心命令与原始命令行不一致，则将 message 更新为展示“外壳包装”与“实际执行内核命令”对照的知情提示；否则使用默认未识别命令提示。

<!-- checkpoint: npm run build -->

## 4. 单元测试覆盖与整体功能回归

- [x] 4.1a 在 `test/action/terminal.test.ts` 中针对 `unboxNestedCommand` 编写核心功能测试，覆盖：多层嵌套解包、带中间 CLI 选项 flags 容忍。
- [x] 4.1b 在 `test/action/terminal.test.ts` 中针对 `unboxNestedCommand` 编写边界及脚本块清洗测试，覆盖：嵌套引号切片防截断、首尾单双引号成对判定防误删、PowerShell 大括号脚本块清洗及常规花括号选项防误伤。
- [x] 4.2 补充针对 `.agent/allowed_commands.json` 自动初始化、`extractSafePrefix` 剥壳前缀抽象、以及 `checkSafety` 剥壳静默放行和 suspend 挂起对比的测试用例（须包含剥壳后未命中白名单的负向拦截与告知场景测试）。

<!-- checkpoint: npm test -->
