## 1. 实现引号感知的防拼接注入逻辑

- [x] 1.1 在 `src/adapters/tools/tools/system/terminal-guard.ts` 中升级 `COMPOSITE_REGEX`，支持分号 `;`、反引号、`$(` 与 `\(` 命令替换的特征防堵。
- [x] 1.2 重构 `validateCommand(command)`，在方法体头部首先自动调用 `unboxNestedCommand(command)` 取得核心解壳命令 `unboxedCmd`。
- [x] 1.3 对 `unboxedCmd` 实现基于状态机的轻量级引号感知扫描：遍历每个字符并跟踪单引号 `'`、双引号 `"`、反引号 `` ` `` 与转义符 `\`，当且仅当在 unquoted（非引号包裹）状态下命中 `COMPOSITE_REGEX` 符号或反引号时阻断执行，并且在输入单/双引号不平衡时直接抛错。

<!-- checkpoint: npx tsc --noEmit -->

## 2. 拦截非只读 Git 变更操作

- [x] 2.1 在 `terminal-guard.ts` 中定义非只读 Git 写/变更操作正则 `DANGEROUS_GIT_WRITE_REGEX`，覆盖 `add`, `commit`, `checkout`, `reset`, `push`, `pull`, `rebase`, `merge`, `stash`, `revert`。
- [x] 2.2 重构 `isHardlineDangerous(command)` 方法（在 `checkSafety` 决策阶段拦截）：首先解壳，若以 `git` 开头且紧随任一 Git 写入子命令则立即返回 `true`，以实现 YOLO/Auto 决策全模式绝对拒绝。
- [x] 2.3 在 `validateCommand(command)` 方法内部（在 `execute` 执行物理阶段拦截）：增加对上述 Git 写入的强制抛错阻断，实现底座防御性兜底，防止绕过 `checkSafety` 直接调用 `execute`。

<!-- checkpoint: npm run lint -->

## 3. 测试与验证

- [x] 3.1 修改 `test/action/terminal.test.ts`，增加针对分号 `;` 和反引号 `` ` `` 命令拼接的拦截测试用例。
- [x] 3.2 增加验证引号安全避让放行（如 `grep "a;b"`）以及外壳包裹分号逃逸注入（如 `powershell "dir; whoami"`）的拦截测试用例。
- [x] 3.3 增加验证在 YOLO 等各种模式下，调用 `git commit`、`git checkout` 等变更指令均会被绝对强力拦截拒绝的测试用例。
- [x] 3.4 运行所有单元测试与集成测试，验证系统功能安全及 100% 绿通。

<!-- checkpoint: npm run test -->
