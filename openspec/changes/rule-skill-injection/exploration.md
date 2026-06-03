# 探索主题: 上下文注入引擎 (Rules & Skills Injection)

## 1. 问题定义
大模型需要在对话上下文中动态感知“全局纪律（Global Rules）”、“局部约束（Local Rules）”以及“扩展能力（Skills）”。我们需要设计一套从存储、加载到 Prompt 最终组装的完整引擎架构。

## 2. 关键发现与调研结果
- **现有逻辑**：目前的 `src/brain/prompts.ts` 中的 `buildSystemPrompt` 仅返回硬编码的静态文本 `BASE_SYSTEM_PROMPT`，没有任何动态上下文拼接能力。
- **核心洞察（关于局部规则）**：局部规则并不专属“写代码”的 Agent。它的本质是 **“基于当前工作区 (Workspace) 或当前任务域 (Domain) 的特化上下文”**。

## 3. 方案对比与推荐方向

### 局部规则 (Local Rules) 作用域选型
| 方案 | 优点 | 缺点 | 结论 |
| :--- | :--- | :--- | :--- |
| **A. 目录级级联 (.gitignore 模式)** | 极度灵活，可为每个子目录定制完全不同的微观规则 | 大幅增加 I/O 扫描成本；容易产生规则冲突；大模型上下文极易爆炸 | ❌ 否决 |
| **B. 工作区级 (.cursorrules 模式)** | 概念清晰，与用户当前授权的工程/目录边界对齐；解析成本极低 | 无法做到非常细粒度的局部子目录定制 | ✅ 采用 |

**推荐路径**：采用 **B (工作区级规则)**。类似于业界主流做法（Cursor 的 `.cursorrules` 或 Windsurf 的 `.windsurfrules`）。我们在 Agent 启动或工作区根目录下，仅寻找唯一的一个 `.agentrules` 或 `.myagent/rules.md` 进行上下文注入。

## 4. 全局规则与技能存储规范
| 方案 | 优点 | 缺点 | 结论 |
| :--- | :--- | :--- | :--- |
| **A. 集中式单文件 (JSON/YAML)** | 解析代码极简 | 极易臃肿，维护灾难，不支持外挂脚本资源 | ❌ 否决 |
| **B. 分布式文件树 (Directory-Based Markdown)** | 极度直观易读；技能高度隔离，支持外挂附件或脚本；这是开源高定 Agent 的标配（如 tinypace-ai 采用 `.agent/skills/<name>/SKILL.md` 范式） | Loader 解析逻辑稍微复杂一点 | ✅ 采用 |

**推荐路径**：采用 **B (分布式文件树)**。
为了防止在开发阶段污染用户真实的根目录 `~` 或产生冲突，我们将采用专门的开发隔离路径：
- 全局规则（Dev）：`D:\Projects\MyAgent\.agent\global_rules.md`
- 局部规则（Dev）：目前先映射到 `D:\Projects\MyAgent\.agent\rules\guize.md`（后续发版时再改为工作区根目录下的 `.agentrules`）
- 技能中心（Dev）：`D:\Projects\MyAgent\.agent\skills\<skill_name>\SKILL.md`

## 5. Prompt 组装规范 (Prompt Assembly)
| 方案 | 优点 | 缺点 | 结论 |
| :--- | :--- | :--- | :--- |
| **A. 纯文本扁平拼接** | 实现极简 | 极易发生“指令跑偏”或被恶意代码注入（Prompt Injection）干扰 | ❌ 否决 |
| **B. 结构化 XML 隔离** | 边界清晰，是大模型（尤其是 Claude 家族）官方推荐的“黄金标准”。能极大提升复杂长指令的服从度 | 需在拼接阶段增加标签闭合的验证 | ✅ 采用 |

**推荐路径**：采用 **B (XML 结构化隔离)**。
Anthropic 官方最佳实践明确指出，使用 `<global_rules>`、`<project_rules>` 和 `<skills>` 等 XML 标签作为边界标识，能显著降低模型歧义。这将被应用于 `src/brain/prompts.ts` 的重构中。

## 6. 加载器时机策略 (Loader Strategy)
| 方案 | 优点 | 缺点 | 结论 |
| :--- | :--- | :--- | :--- |
| **A. 静态启动加载** | 仅读盘一次，性能最优 | 每次修改 `rules` 后必须重启进程，UX 极差 | ❌ 否决 |
| **B. 实时热更新 (Hot Reload)** | 类似 Cline 的 `.clinerules` 体验，修改规则保存后，下一次对话立即生效，丝滑无缝 | 需在每次构建 Prompt 时执行轻量级的文件 I/O | ✅ 采用 |

**推荐路径**：采用 **B (实时热更新)**。
根据全网针对 Cline 等前沿工具的调研，免重启的热更新是智能体的标配。由于规则文件体量很小，在构建 System Prompt 时实时 `readFileSync` 的性能损耗完全可以忽略不计。
