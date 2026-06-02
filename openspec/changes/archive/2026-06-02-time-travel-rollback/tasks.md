## 1. 核心状态中断控制

- [x] 1.1 在 `SessionManager` 类中增加 `abortController: AbortController` 私有成员及 `abort()` 公开方法
- [x] 1.2 修改 `chat()` 内部的 `chat.completions.create` 调用，注入 `signal: this.abortController?.signal`
- [x] 1.3 在 `chat()` 中安全捕获中止异常（如 `AbortError` 或 `APIUserAbortError`），在被触发时重置状态并产生相应的中断事件输出

<!-- checkpoint: npx tsc --noEmit -->

## 2. 记忆上下文截断 (Context Rollback)

- [x] 2.1 在 `SessionManager` 类中新增 `rollback(turns: number)` 公开方法
- [x] 2.2 实现针对 `this.messageHistory` 的数组弹栈（`splice`/`pop`），安全阈值需判定确保保留下标为 0 的首条 `system` 角色设定

<!-- checkpoint: npx tsc --noEmit -->

## 3. 终端入口热键联动与指令

- [x] 3.1 在 `src/index.ts` 或 CLI 层面上开启 `process.stdin.on('keypress')`，监听原生的 `escape` 按键，维护 500ms 内的“双击”判定时间窗
- [x] 3.2 判定双击 ESC 时的系统状态：若正在生成中，调用 `sessionManager.abort()`；若正处于 idle 输入态，则调用 `sessionManager.rollback(1)` 实现一次撤销，并刷新终端提示
- [x] 3.3 在 `src/interface/command.ts` 中新增 `/rollback [turns]` 斜杠命令，允许用户一次性回滚任意指定数量的会话轮次
- [x] 3.4 在 `handleHelpCommand` 中补充对 `/rollback` 指令以及 `双击 ESC` 快捷键的系统帮助说明
- [x] 3.5 确保界面渲染层能够正确处理“连续回滚”，每次回滚后给出明确的反馈（如：已撤销至上一轮对话）

<!-- checkpoint: npx tsc --noEmit -->
