## 1. 后端大脑层清理与重构 (Context Engine)

- [x] 1.1 清理 `src/brain/context.ts`，删除 `pinnedSkills` 和 `disabledSkills` 相关的方法和成员变量。
- [x] 1.2 修改 `src/brain/prompts.ts` 的 `buildSystemPrompt` 签名，移除状态参数，保持全局静态规则的唯一纯净拼接。
- [x] 1.3 在 `src/brain/session.ts` 中废弃引用的状态变更方法，并重构 `chat(transientSkillContent?: string)` 方法。使其能够在发往底层驱动前，将临时技能动态克隆并压入发送数组的尾部。

<!-- checkpoint: npm run build -->

## 2. 前端命令与路由层重构 (CLI Layer)

- [x] 2.1 重构 `src/interface/command.ts`，删除过时的 `/skill pin | unpin | enable | disable` 解析分支。
- [x] 2.2 修改 `/skill` 的解析逻辑，使其接收 `/skill <skill_name> <task>` 格式，加载文件后通过携带临时技能调用 `session`。
- [x] 2.3 更新 `src/interface/command.ts` 中的 `/help` 菜单打印文本，添加对单行 `/` 以及 `/skill <name> <task>` 的说明。
- [x] 2.4 修改 `src/interface/command.ts` 中的 `handleToolCommand`，兼容无参调用，使其默认为 `list` 行为，修复前端菜单直接触发 `/tool` 时的报错。

<!-- checkpoint: npm run build -->

## 3. 交互式菜单体验升级 (@clack/prompts)

- [x] 3.1 修改 `src/interface/cli.ts` 的预处理器，检测到单行仅包含独立 `/` 时，执行 `rl.close()` 脱离 readline 管控。
- [x] 3.2 使用 `@clack/prompts` 的 `select` 菜单渲染可用命令的图形化列表（包含使用技能、切换模型等）。
- [x] 3.3 实现表单链：选择技能模式后，进一步用 `select` 展示由 `loadSkills()` 解析的技能列表；选定后再用 `text` 组件获取具体要求任务，最终完成交接调用。
- [x] 3.4 确保所有终端表单交互完毕后，重新执行 `initRl()` 恢复后续对话流。

<!-- checkpoint: npm run build -->
