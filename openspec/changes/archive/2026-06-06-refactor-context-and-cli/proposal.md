## 改造原因

现有的 `/skill pin` 和 `/skill disable` 机制采用在上下文进行硬编码拼接的方式。这种“狗皮膏药”式的单片字符串重构极大地破坏了大模型基于前缀的缓存（Prompt Caching），同时全局挂载某一技能容易导致大模型发生“注意力稀释（Attention Dilution）”与“视野狭窄（Tunnel Vision）”。
此外，终端界面的 `/` 命令触发缺乏现代交互感，当前的 `readline` tab 补全体验不够直观。通过探索与调研，我们决定结合“历史流动态入栈”与“孤立回车触发”技术，兼顾提示词缓存降本、垂直任务高专注度以及终端命令交互体验。

## 变更内容

- **[BREAKING]** 移除原有 `/skill pin`、`unpin`、`disable`、`enable` 子命令。
- 引入按需的单次临时技能沙盒：使用 `/skill <skill-name> <task>` 将对应的技能只在当前请求的上下文历史记录尾端进行“入栈（Push）”，并在大模型处理完毕后“出栈（Pop）”，完全不破坏头部的基线缓存。
- 当用户在空行仅输入 `/` 并按下回车时，暂停 `readline`，触发基于 `@clack/prompts` 的全屏交互式菜单下拉选择，提供对 `/skill`、`/model` 等核心能力的可视化调度。

## 业务能力

### 新增业务能力
无。本次更新本质上是对于已存在能力的底层架构与交互的深度重构。

### 修改业务能力
- `context-injection-engine`: 将全局死锁拼接（String concatenation）改为对话历史流的动态尾端出入栈（History Stream Push-Pop），实现“动静分离”。
- `cli-autocomplete`: 将 `readline` 简易的补全机制升级为针对独立 `/` 命令的拦截，拉起 `@clack/prompts` 的富交互表单。

## 影响范围

- **大模型会话调度**: `SessionManager.chat()` 需要支持可选的临时技能参数，并在底层数组层面进行操作。
- **系统上下文构建**: `SessionContext` 及其相关的提示词构建机制，将不再保留 `pinnedSkills` 与 `disabledSkills` 状态。
- **命令行界面**: `src/interface/cli.ts` 的命令拦截器将被重构。
- **CLI 命令分发**: `src/interface/command.ts` 将废弃状态管理相关的子命令处理器。
