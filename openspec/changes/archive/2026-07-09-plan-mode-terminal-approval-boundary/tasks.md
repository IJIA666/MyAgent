## 1. `terminal-guard.ts` 新增 Plan 安全判定函数

- [x] 1.1 在 `terminal-guard.ts` 中新增 `isPlanSafeCommand(command: string, shellKind?: ResolvedShellKind): boolean` 函数，整合三个判定条件：
  - `checkCommandSafetyLevel(command, shellKind) === 'allow'`（当前已决议 shell 下命中只读白名单前缀）
  - `!isHardlineDangerous(command, shellKind)`（非毁灭级命令）
  - `validateCommand(command, shellKind)` 不抛错（直接复用执行期结构校验，含引号感知）
- [x] 1.2 在 `isPlanSafeCommand` 的 JSDoc 中明确标注与 `validateCommand` 的同构关系，并说明必须按当前已决议 shell family 判定，不得使用跨 shell 的宽松白名单匹配
- [x] 1.3 从 `terminal.ts` 中导入 `isPlanSafeCommand`（与 `validateCommand`、`checkCommandSafetyLevel` 并列导入）

<!-- checkpoint: npx tsc --noEmit -->

## 2. `terminal.ts` Plan 模式拦截逻辑重构

- [x] 2.1 修改 `ExecuteCommandTool.checkSafety` 中 Plan 模式分支（约 125-133 行）：将 `if (safetyLevel !== 'allow') return deny` 替换为 `if (!isPlanSafeCommand(command, resolvedShellKind)) return deny`，通过判定后继续走统一审批路径，而不是在 Plan 分支中直接 `pass`
- [x] 2.2 更新 Plan 模式拦截时返回的自愈引导消息：反映新的"无副作用"语义——允许白名单只读查询、禁止复合连接/重定向/变量展开、引导使用原生工具作为首选
- [x] 2.3 验证修改后 Plan 模式下 `isPlanSafeCommand` 返回 true 的命令（如 `dir C:\Windows\Temp`）会进入统一审批流程；任何含复合字符、最终会被 `validateCommand` 拒绝的命令都不得进入审批流程

<!-- checkpoint: npx tsc --noEmit -->

## 3. `prompts.ts` Plan 模式终端语义更新

- [x] 3.1 更新 `RULE_TOOL_PRIORITY` 中 Plan 模式段落：将"严禁调用 execute_command 进行任何分析或检索"改为"允许发起可静态证明安全的系统只读查询审批请求，严禁复合连接、重定向、环境变量展开及写倾向操作"
- [x] 3.2 追加细化规则：明确当原生只读工具（list_dir、read_file、grep_search）无法覆盖特定系统查询需求时，终端工具可作为补充手段，但必须严格遵守只读白名单与无复合字符约束

<!-- checkpoint: npx tsc --noEmit -->

## 4. 单元测试

- [x] 4.1 在 `test/adapters/tools/terminal.test.ts` 中新增 `isPlanSafeCommand` 测试用例（test 14）：
  - 只读白名单命令无复合字符 → 返回 true（如 `dir C:\Windows\Temp`、`type package.json`、`git status`）
  - 只读白名单命令含复合字符 → 返回 false（如 `dir /-C | find "txt"`、`type a.txt > b.txt`）
  - 非白名单命令 → 返回 false（如 `wmic logicaldisk`）
  - 危险写命令 → 返回 false（如 `del file.txt`）
  - 硬红线命令 → 返回 false（如 `rm -rf /`）
  - shell family 约束测试：验证命令必须在当前已决议 shell 下真实可执行，不能靠跨 shell 白名单命中被误放行
- [x] 4.2 在 `test/adapters/tools/terminal.test.ts` 中新增 Plan 模式 checkSafety 测试用例（test 15）：
  - Plan 模式 + 安全只读命令（`dir C:\Windows\Temp`）→ `checkSafety` 返回 `{ status: 'suspend' }`，进入统一审批流程
  - Plan 模式 + 含复合字符命令 → `checkSafety` 返回 `{ status: 'deny' }` 并含自愈引导
  - Plan 模式 + 非白名单命令 → `checkSafety` 返回 `{ status: 'deny' }` 并含自愈引导
  - Plan 模式 + 危险写命令 → `checkSafety` 返回 `{ status: 'deny' }`
  - Auto/Safe/YOLO 模式回归：验证非 Plan 模式下的 `checkSafety` 行为不受影响
- [x] 4.3 在 `test/adapters/tools/terminal.test.ts` 中新增同构回归用例（test 16）：
  - Plan 模式下任何会被执行期结构校验拒绝的命令，都必须在 `checkSafety` 阶段直接 `deny`
  - Plan 模式下进入审批的命令，在审批放行后不得因同一批复合字符规则再次于执行期失败

<!-- checkpoint: npm run test -->
