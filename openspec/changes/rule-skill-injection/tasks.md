## 1. 核心上下文加载器 (Context Loader)

- [x] 1.1 创建 `src/brain/contextLoader.ts` 工具模块。
- [x] 1.2 实现 `loadGlobalRules()` 方法，以 UTF-8 读取 `D:\Projects\MyAgent\.agent\global_rules.md`。若文件不存在则返回空字符串。
- [x] 1.3 实现 `loadLocalRules()` 方法，读取 `D:\Projects\MyAgent\.agent\rules\guize.md`。若文件不存在则返回空字符串。
- [x] 1.4 实现 `loadSkills()` 方法，遍历 `D:\Projects\MyAgent\.agent\skills\` 目录，寻找所有的 `SKILL.md` 文件。
- [x] 1.5 完善 `loadSkills()`，使其能剥离 `SKILL.md` 顶部的 YAML Frontmatter，并解析出 `name` 和 `description` 元数据。

<!-- checkpoint: npx tsc --noEmit -->

## 2. Prompt 组装引擎重构

- [x] 2.1 修改 `src/brain/prompts.ts`，在 `buildSystemPrompt` 中调用 `contextLoader` 相关方法（实现热更新）。
- [x] 2.2 构造 XML 组装逻辑：若 global rules 非空，将其使用 `<global_rules>` 标签包裹；若 local rules 非空，使用 `<project_rules>` 包裹。
- [x] 2.3 构造技能组装逻辑：[Amend 追加] 仅将解析出的技能名称与描述组装成 `<available_skills>` 索引；对于当前 Session 中被显式启用的技能（包括模型主动加载或用户配置），将其全文使用 `<active_skills>` 注入。
- [x] 2.4 将原有的硬编码 `BASE_SYSTEM_PROMPT` 与上述动态 XML 块组合并返回最终字符串。

## 3. [Amend 追加] 命令行 /skill 支持

- [x] 3.1 在 `src/interface/command.ts` 中新增 `/skill` 分支路由。
- [x] 3.2 实现 `/skill list` 子命令，格式化输出所有被发现的技能及其摘要。
- [x] 3.3 实现 `/skill enable <name>` 和 `/skill disable <name>` 子命令，将其状态持久化至 Session 上下文中。

## 4. [Amend 追加] LLM 自主工具驱动 (Tool-driven Invocation)

- [x] 4.1 在 `src/action/tools.ts` (或新增文件) 中注册内部系统工具 `load_skill` 或 `skill_view`。
- [x] 4.2 实现该工具的回调逻辑：将目标技能标为启用并将其全文注入到当前的对话上下文（或直接在工具调用结果中返回该技能的全部 markdown 内容）。

## 5. [Amend 追加] 偿还 YAML 解析技术债

- [x] 5.1 使用项目统一的包管理工具安装 `gray-matter` 依赖 (`npm i gray-matter`)，以及类型定义 (`npm i -D @types/gray-matter`)。
- [x] 5.2 重构 `src/brain/contextLoader.ts` 中的 `parseSkillFrontmatter` 方法，使用 `gray-matter` 解析元数据并兼容现有业务逻辑。

<!-- checkpoint: npx tsc --noEmit -->

## 6. [Amend 追加] 鲁棒性重构与性能改良 (Robustness & Performance)

- [x] 6.1 重构 `src/brain/contextLoader.ts`，引入内存缓存池（如 `skillsCache`），并实现后台异步监听（类似 Tinypace 的机制）以在文件变更时更新缓存。
- [x] 6.2 改造 `findSkillFiles` 搜索算法，增加 `maxDepth` 限制（如最大深度为 3），并检测及跳过符号链接 (Symlink) 防止递归死循环崩溃。
- [x] 6.3 调整 `loadSkills()` 的返回值，使其仅从内存中极速返回技能索引元数据；将全量 Markdown 读取逻辑独立为 `loadSkillContent(name: string)`，实行严格的按需懒加载 (Lazy Load)。
- [x] 6.4 擦除前期任务（1.4、1.5）中遗留的同步阻塞读盘（`readFileSync`）和全量提取技术债，确保 `buildSystemPrompt` 主链路耗时降至微秒级。
- [x] 6.5 [Debug 修正] 修复 `virtual-mcp.ts` 中的 `load_skill` 调用，适配 `loadSkillContent` 懒加载接口，消除编译错误。
- [x] 6.6 [Debug 修正] 修复 `contextLoader.ts` 中 `findSkillFiles` 寻找 `SKILL.md` 时因为 `toUpperCase` 导致的永远返回 false 的字符串比较低级错误。

<!-- checkpoint: npx tsc --noEmit -->

## 7. [Verify 追加] 代码质检修复 (Linting Fixes)

- [x] 7.1 修复 `src/brain/contextLoader.ts` 中第 81 行和 85 行的 `@typescript-eslint/no-unused-vars` 报错（由于存在吞没异常的空 catch 块导致 `err` 变量未使用），请改为去掉 `err` 声明或补充适当的日志打印。
## 8. [Amend 变更] 人工挂载机制优化

- [x] 8.1 修改 `src/brain/context.ts`，在 `saveState` 和 `loadState` 中移除对 `activeSkills` 的持久化写入和读取，使其变为纯粹的内存态/单次会话级缓存。
- [x] 8.2 修改 `src/interface/command.ts` 中的 `handleSkillCommand`：
  - 增强 `list` 动作：清晰标识出当前哪些技能是被“强行常驻挂载”的，哪些只是提供“按需拉取”的索引。
  - 增强 `enable/disable` 动作：在控制台打印时，准确提醒用户该操作“仅在当前会话生效”。

## 9. [Amend 变更] 挂载语义重构与真实黑名单机制

- [x] 9.1 `src/brain/context.ts`：将原有的 `activeSkills` 改名为 `pinnedSkills`，并新增 `disabledSkills` 黑名单数组。提供 `pin/unpin` 和真实的 `enable/disable` 接口。
- [x] 9.2 `src/brain/prompts.ts`：修改 `buildSystemPrompt`，在生成 `<available_skills>` 索引时，过滤掉被加入黑名单的 `disabledSkills`。
- [x] 9.3 `src/brain/session.ts`：
  - 暴露对应的管理接口给 CLI。
  - **关键修复**：移除在 `load_skill` 工具执行后自动调用 `enableSkill`（现 `pinSkill`）的错误逻辑，保证懒加载不会意外变成永久常驻！
  - 在 `load_skill` 拦截处，如果请求的技能在黑名单内，直接抛出异常拒绝大模型读取。
- [x] 9.4 `src/interface/command.ts`：全面重构 `/skill` 子命令，支持 `list`, `pin`, `unpin`, `enable`, `disable`，并在 `list` 中直观展示三种不同状态标签。

## 10. [Debug 修复] 状态机流转限制与提示优化

- [x] 10.1 `src/interface/command.ts`：在执行 pin/unpin/enable/disable 前，先检查当前状态（如是否已经置顶、是否根本没置顶等），拦截无效的状态转换并给予用户正确的反馈。
