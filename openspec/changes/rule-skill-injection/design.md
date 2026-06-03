## 背景

大模型在处理特定任务时，需要明确的背景约束（如项目级的代码规范、安全准则）以及能被大模型复用的经验（Skills）。目前 `MyAgent` 在启动和对话交互时，只能给大模型发送固定的静态 System Prompt，扩展性较差，且随着系统复杂度增加，Prompt Injection 风险极大。我们需要设计一套稳定、安全的动态上下文注入机制。

## 目标与非目标

**目标:**
- 实现对 `Global Rules`、`Local Rules` (`.agentrules`) 和 `Skills` 的动态探测与加载。
- 采用 XML 结构化排版将外部内容隔离注入大模型的 System Prompt。
- 保证规则的修改能够即时生效（无需重启 Node 进程）。

**非目标:**
- 不支持远程网络下载规则（仅限本地 I/O）。
- 不解析 Markdown 内部的复杂引用（即不对 `SKILL.md` 的内容进行 AST 分析，仅作为纯文本读取，保留 YAML frontmatter 作为元数据剥离）。

## 架构决策

- **决策 1：存储选型使用分布式 Markdown (Directory-Based Markdown)**
  - 理由：技能 (Skill) 往往不仅包含指令文本，还需要配合脚本或图片作为附属资料。单一 JSON/YAML 无法满足高定扩展需求，目录加 Markdown 文件更为自然。
- **决策 2：Prompt 组装采用 XML 结构化隔离**
  - 理由：大模型（特别是 Claude 家族）对 `<tags>` 的边界感知最为敏感，使用 `<global_rules>`、`<project_rules>` 和 `<available_skills>` 等包裹外挂文本，能够有效防御“指令跑偏”与“越狱干扰”。
- **决策 3：[Amend 修正] 技能意图识别采用 Tool-driven Index + Manual 混合模式**
  - 理由：全量注入技能文本会导致 Token 浪费和 Prefix Cache 命中率下降。系统仅向底层 Prompt 注入 `<available_skills>`（名称与摘要索引），并注册系统内置工具（例如 `skill_view`），大模型自行判断意图并按需拉取；同时支持用户通过 `/skill` 命令行强行干预。
- **决策 4：加载策略采用实时读取 (Sync I/O on request)**
  - 理由：避免繁琐的 `fs.watch` 或启动时全盘预加载，在每次调用大模型前执行同步 `fs.readFileSync`。现代 OS 文件系统在缓存少量文本时性能极快，不会造成明显延迟，并且带来了修改后即时生效的完美开发体验。
- **决策 5：[Amend 修正] YAML 解析策略采用全量解析库 `gray-matter`**
  - 理由：最初使用正则表达式提取导致实现脆弱且无法应对嵌套结构。采用业界标准的 `gray-matter` 以确保系统的健壮性并支持复杂的 Agent Metadata 扩展。

## 风险与权衡

- [Risk] I/O 阻塞：如果在每次构建 Prompt 时读取海量文件可能造成 Node 事件循环轻微停顿。
  - [Mitigation] 仅读取指定路径下的小文本文件，不做深层递归扫描。
- [Risk] 权限问题：如果读取用户 `.agents` 下的文件失败。
  - [Mitigation] 增加异常捕获，若读取失败，则在终端优雅打印警告，但不阻断主流程。
