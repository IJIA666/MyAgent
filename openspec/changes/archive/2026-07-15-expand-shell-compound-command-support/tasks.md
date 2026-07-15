## 0. 前置清理：删除自动代码质量门禁

- [x] 0.1 删除 `AgentLoop` 完成响应后自动运行 ESLint/TypeScript、失败后注入修复消息并再次调用模型的整条控制流；同步删除仅为该门禁服务的 effect/资源累计状态、`QualityCheckPort`、`ShellQualityCheckAdapter`、Session/组合根注入、`quality_check_status` 事件、CLI 渲染、专用日志常量及对应测试，同时保留 AI 或用户通过终端主动运行类型检查、Lint 和测试的能力。

<!-- checkpoint: npx tsc --noEmit -->
<!-- checkpoint: npx vitest run test/core/usecases/engine/agent-loop.test.ts test/core/usecases/engine/SessionManager.test.ts test/adapters/input/interface/CliFacade.test.ts -->

## 1. 异步解析契约与能力开关

- [x] 1.1 在 `package.json` 引入 Bash token/parser 依赖及必要类型，禁止复制参考项目源码；记录锁文件变更。
- [x] 1.2 修改 `command-analysis/types.ts`、`analyze-shell-command.ts` 和各 Shell analyzer，使分析接口异步，并新增管道、重定向、嵌套路径及 `ShellCompoundFeatureConfig` 契约；公开 API 使用标准 TSDoc。
- [x] 1.3 在命令分析域和 `src/adapters/tools/tool-factory.ts` 增加五类内部能力覆盖及构造参数注入；正常运行默认启用全部已验收能力，不进入 `AppConfig` 或环境变量，测试可显式关闭单项能力。
- [x] 1.4 更新 `test/adapters/tools/command-analysis.test.ts`，锁定全部开关关闭时与阶段 3 等价，并覆盖异步解析错误、超时和缓存边界。

<!-- checkpoint: npx tsc --noEmit -->
<!-- checkpoint: npx vitest run test/adapters/tools/command-analysis.test.ts -->

## 2. 纯读取管道

- [x] 2.1 为 POSIX 分析器实现 `|`、`|&` 和多级管道节点提取，确保引号、转义和管道文本不被误拆。
- [x] 2.2 为 PowerShell AST 适配器实现 PipelineAst 命令段提取、别名归一化和最小 JSON 输出，并增加短超时、输出上限与有界缓存。
- [x] 2.3 聚合所有管道段的副作用：全部 read 才 allow，任一 sensitive-read/write/unknown 至少 ask，任一 hardline deny。
- [x] 2.4 在 `command-analysis.test.ts` 与 `terminal.test.ts` 覆盖 Bash/PowerShell 单级、多级、混合风险、引号内管道和关闭 pipelines 开关回退。

<!-- checkpoint: npx vitest run test/adapters/tools/command-analysis.test.ts test/adapters/tools/terminal.test.ts -->

## 3. 条件链与语句连接

- [x] 3.1 保持 Bash `;`、`&&`、`||` 现有行为，迁移到新 parser 节点并验证短路连接关系不丢失。
- [x] 3.2 使用 PowerShell PipelineChainAst/语句 AST 支持 `;`、PowerShell 7 的 `&&`、`||` 和换行连接；解析器必须根据实际 Shell 能力返回 parsed 或 unsupported。
- [x] 3.3 覆盖任一分支 hardline 整体 deny、任一分支 ask 整体一次 ask、条件开关关闭回退，以及 50 节点上限转 ask。

<!-- checkpoint: npx vitest run test/adapters/tools/command-analysis.test.ts test/adapters/tools/terminal.test.ts -->

## 4. 重定向

- [x] 4.1 在 POSIX 解析结果中提取 `<`、`>`、`>>`、标准文件描述符、流合并和 heredoc；静态目标生成资源，动态展开目标至少 ask。
- [x] 4.2 在 PowerShell AST 结果中提取输出、追加、错误流和流合并重定向，区分文件写入与纯流合并。
- [x] 4.3 将重定向 read/write effect 合入同一 `ToolPermissionEvidence`，禁止只根据管道首命令自动 allow。
- [x] 4.4 覆盖工作区内外目标、敏感输入、追加写入、动态目标、引号和关闭 redirections 开关回退。

<!-- checkpoint: npx vitest run test/adapters/tools/command-analysis.test.ts test/adapters/tools/terminal.test.ts -->

## 5. 后台执行

- [x] 5.1 区分 POSIX 尾部/连接后台 `&` 与 PowerShell 调用操作符、后台操作符，避免跨 Shell 误判。
- [x] 5.2 将后台节点接入现有 terminal task id、EventNotificationPort、取消、超时和进程树清理；不能托管的结构保持 ask/deny。
- [x] 5.3 覆盖快速失败、正常后台完成、取消、超时、子进程树清理、关闭 background 开关和 hardline 后台命令拒绝。

<!-- checkpoint: npx vitest run test/adapters/tools/terminal.test.ts test/integration/runtime-effect-lifecycle.test.ts -->

## 6. 嵌套结构

- [x] 6.1 支持 Bash 子 Shell、命令分组、命令替换和反引号中的递归节点提取，设置嵌套深度与总节点双重上限。
- [x] 6.2 支持 PowerShell 脚本块、子表达式、可展开字符串和控制流中的命令节点提取，保留父子路径和资源证据。
- [x] 6.3 将 `eval`、`Invoke-Expression`、EncodedCommand 及其他隐藏真实执行面的动态结构标记为 deny；无法完整分析但非 hardline 的合法结构只能 ask。
- [x] 6.4 覆盖嵌套 hardline、嵌套写入、深度/数量上限、引号字面量、关闭 nested 开关和解析器差异夹具。

<!-- checkpoint: npx vitest run test/adapters/tools/command-analysis.test.ts test/adapters/tools/terminal.test.ts -->

## 7. 权限与执行期收口

- [x] 7.1 修改 `src/adapters/tools/impl/system/terminal.ts`：hardline/invalid 返回 deny，unsupported 或未知结构返回 ask，只有完整 parsed 且全部 allow 才自动 allow。
- [x] 7.2 修改 `terminal-guard.ts` 和授权执行调用：执行前消费 `AuthorizedExecutionContext.evidence`，移除对同一命令的二次分析及 `parseStatus !== parsed` 重复拒绝，同时保留 cwd、授权令牌和运行时 hardline 约束。
- [x] 7.3 保持 Plan 模式仅自动执行可证明只读的 parsed 结构；unknown/unsupported 不得因用户规则或模式被提升为自动 allow。
- [x] 7.4 限制复合命令授权建议为实际 ask 子命令且最多 5 条；未知或嵌套整串命令不得生成持久宽泛 allow 规则。
- [x] 7.5 在权限服务、Gateway 和 terminal 测试中覆盖一次分析、一次聚合 ask、授权后成功执行、拒绝不可绕过及 effect 与资源不漂移。

<!-- checkpoint: npx vitest run test/core/domain/permissions test/adapters/tools/terminal.test.ts test/adapters/tools/tool-call-gateway.test.ts -->

## 8. 阶段验收与清理

- [x] 8.1 删除阶段 3 扫描器中已被 parser 取代的结构分支和过期注释，保留可复用 hardline/原子分析逻辑；执行旧行为与死导出零残留检查。
- [x] 8.2 运行 TypeScript、命令分析、终端、权限、Gateway、后台生命周期和平台测试，确认五个开关可独立启停。
- [x] 8.3 在根目录手动执行代表性 Bash/PowerShell 对话用例，核对日志中一次命令只有一次分析、至多一次审批，且未覆盖语法不会自动 allow。

<!-- checkpoint: npx tsc --noEmit -->
<!-- checkpoint: npx vitest run test/adapters/tools/command-analysis.test.ts test/adapters/tools/terminal.test.ts test/core/domain/permissions test/integration/runtime-effect-lifecycle.test.ts -->
