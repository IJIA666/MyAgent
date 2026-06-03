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
