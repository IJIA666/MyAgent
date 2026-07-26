## 背景

旧记忆运行时已整体删除，当前代码中不存在可复用的 `MemoryService`、RAG、Embedding 或 VectorDB 链路。现有系统已经具备本次能力需要的基础边界：

- `ApplicationPaths` 根据规范化 workspace 生成稳定 `workspace-key`，并提供 `projectDataDir`。
- `SessionContext` 持有 system prompt 和持久会话历史。
- `ModelRequestAssembler` 在真实模型调用前构造非持久化请求投影，并在最终阶段执行预算协调。
- `CompactionService` 只在候选历史验证和持久化成功后提交压缩。
- 标准文件工具统一经过 `secureResolveReadPath()`、`secureResolveWritePath()` 和现有 PermissionMode。

Auto Memory 必须接入这些现有边界，而不是恢复旧插件或建立第二套工具运行时。

## 目标与非目标

**目标:**

- 以 Markdown 作为长期记忆唯一事实源，按项目隔离、机器本地保存并允许人工审计和编辑。
- 启动时只加载有界 `MEMORY.md` 索引，主题正文由主 Agent 在相关时使用标准文件工具读取。
- 固定 `user`、`feedback`、`project`、`reference` 四种类型，并通过稳定 system prompt 约束保存、排除、召回、命名、复用和忘记行为。
- 把实际索引作为独立、非持久化的 user 角色上下文加入请求，不把可能过期的记忆提升为 system 指令。
- 复用现有文件工具、安全路径解析、权限模式、上下文预算和压缩提交语义。

**非目标:**

- 不增加专用 `memory` 工具、语义搜索、Embedding、VectorDB、数据库、分块或记忆专用模型。
- 不在 `SessionClosed` 或每个回合结束时自动提炼会话。
- 不实现用户全局记忆、跨项目合并、团队共享、旧 `.agent/MEMORY.md` 迁移或多进程写入合并。
- 不按记忆写入次数刷新当前会话快照，不把 200 行/20KB 阈值做成第一版配置。
- 不增加 `/memory` 编辑器；标准文件工具和直接编辑 Markdown 是第一版写入入口。

## 架构决策

### 1. 记忆目录属于项目私有数据根

`ApplicationPaths` 增加：

```text
memoryDir = <projectDataDir>/memory
```

最终布局为：

```text
~/.myagent/projects/<workspace-key>/
├── logs/
├── state/
├── artifacts/
├── tmp/
└── memory/
    ├── MEMORY.md
    └── topics/
```

该选择保持 workspace `.myagent/` 只承载配置、规则和技能，并让同一路径规范化结果决定会话、日志和记忆的共同项目身份。目录按需创建；不存在 `MEMORY.md` 时启动行为与当前基线相同。

替代方案是 `<workspace>/.myagent/memory/`，但它违反现行 `application-data-layout`，还会增加误提交私有记忆的风险，因此否决。

### 2. 使用只读加载器和会话冻结快照

在 `src/core/usecases/brain/` 增加 Markdown 记忆上下文加载器。加载器只接收注入的绝对 `memoryDir`，职责为：

- 读取 `MEMORY.md` 的前 200 行和前 20KB，先到者为准；
- 超限时只截断注入快照并附加明确标记，不改写磁盘；
- 校验索引链接指向的主题路径、单层 kebab-case 文件名和 frontmatter；
- 报告重复索引、断链、非法文件名、未知或缺失类型；
- 返回不可变 `MemorySnapshot`，不自动创建、合并或修复 Markdown。

索引链接数量天然受 200 行上限约束；加载器只校验实际进入快照的链接，不扫描无界目录，也不承担语义去重。

`SessionContext` 保存当前 `MemorySnapshot`。普通请求、规则 watcher 和技能刷新都复用同一快照，避免磁盘变化反复破坏请求前缀。

### 3. 机制规则与实际记忆分离

`buildSystemPrompt()` 只增加稳定的 Auto Memory 机制规则：

- 四种类型及各自保存条件；
- 不保存可从源码、配置或 Git 推导的内容、临时任务状态、修复配方、已有规则、未经确认推测和秘密；
- 访问相关主题前先看索引，过期事实必须以当前源码和工具结果为准；
- 创建前优先复用主题，遵守命名与先主题后索引的顺序；
- 用户要求忘记后立即停止应用和引用相关内容。

实际 `MEMORY.md` 不进入 system prompt。`ModelRequestAssembler` 在 `contextAdapter.assemble()` 之后、`BeforeModel` 之前，将冻结快照包装为一条独立 `role: 'user'` 消息，插在连续 system 前缀之后、持久会话消息之前。该消息使用明确的 `<memory-context>` 数据边界，声明内容可能过期、只在相关时使用，并始终提供当前项目实际的绝对 `memoryDir`。即使索引为空，也必须注入只包含目录和空索引说明的最小消息，使模型能够通过标准文件工具创建第一份记忆。来自索引的标题和描述必须转义数据边界字符。

MyAgent 的 `ChatMessage` 没有 Claude Code 内部的 `isMeta` 字段，因此“meta user context”只表示请求投影语义，不新增或向 OpenAI 协议发送未知字段。该消息不写入 `SessionContext` 历史、不进入会话持久化，也不作为压缩摘要源；最终预算协调器仍能看到它的真实 token 开销。

### 4. 标准文件工具获得精确 memoryDir 边界

不注册新工具。组合根把规范化物理 `memoryDir` 注入文件路径安全模块，`secureResolveReadPath()` 与 `secureResolveWritePath()` 允许：

1. 原授权 workspace 子树；
2. 当前项目 `memoryDir` 子树。

判定必须使用 `getPhysicalRealPath()` 和真实子路径关系。不得放行 `projectDataDir`、`~/.myagent/projects/`、其他 workspace-key 或 memoryDir 的符号链接逃逸目标。

该静态路径根只解决“标准文件工具能够到达记忆目录”，不绕过工具 effect 和 PermissionMode：读取/列举仍报告 read，创建/编辑/删除仍报告 write，并沿用正常工具授权与 Plan 模式限制。

### 5. Markdown 结构和写入顺序由模型规则约束

主题文件采用：

```yaml
---
name: 项目背景
description: 记录无法从代码和 Git 推导的项目动机、期限与约束
type: project
---
```

文件保持 `topics/` 单层，名称匹配 `[a-z0-9]+(?:-[a-z0-9]+)*\.md`。创建前必须读取索引并列举主题，优先合并到已有相关主题。确需新建时先写主题文件，再更新 `MEMORY.md`。

主题 frontmatter 是事实源，`MEMORY.md` 是可确定性重建的导航索引。标准文件工具只能保证单文件写入安全，不能提供跨文件事务；索引更新失败时保留已写入主题并明确报告断链，由后续标准文件操作修复。

忘记单条内容时只编辑主题正文；主题清空或用户忘记整个主题时，先删除正文或主题文件，再删除索引。该顺序优先保证被要求忘记的正文不继续留在磁盘，即使失败后暂时留下断链。

### 6. 仅在成功压缩后刷新快照

`CompactionService` 成功替换并持久化候选历史后，调用注入的记忆加载器重新读取磁盘并更新 `SessionContext` 快照。刷新失败不得回滚已经成功提交的会话压缩；系统保留旧快照、记录明确诊断，并继续会话。

压缩失败或跳过时不得刷新。普通记忆写入也不触发计数器或 watcher 刷新，因为当前对话和文件工具结果已经包含刚写入的信息。下一会话和下一次成功压缩是唯一刷新边界。

## 风险与权衡

- **记忆影响模型判断** -> 实际内容使用独立 user 消息、明确数据边界和非权威声明；当前用户消息、源码和工具结果优先。该措施只能缓解提示词注入，不能证明风险消失。
- **索引与主题短暂不一致** -> 主题 frontmatter 作为事实源，加载器报告断链和重复项；不虚假承诺跨文件事务。
- **主题重复** -> system prompt 要求创建前列举与优先复用，加载器检查文件名和索引结构；第一版不做语义去重。
- **当前会话使用旧索引** -> 文件工具结果保持刚写入内容在当前对话可见；成功压缩或新会话后刷新磁盘快照。
- **workspace 外文件访问边界扩大** -> 只注入当前项目 memoryDir，使用物理路径判定，并增加兄弟目录、其他 workspace-key 和符号链接逃逸测试。
- **多实例丢失更新** -> 第一版明确不保证并发合并；单文件原子替换只防损坏。出现真实需求后再评估文件锁或版本检查。
- **固定容量不适合未来规模** -> 第一版使用 200 行/20KB 常量和诊断；有真实截断数据后再讨论配置化或文本搜索。

## 迁移与回滚

1. 扩展 `ApplicationPaths` 并注入 `memoryDir`，但不主动创建目录。
2. 上线加载器、快照和请求投影；无 `MEMORY.md` 时返回空快照，但请求投影仍提供实际 `memoryDir`。
3. 扩展文件安全根，使主 Agent 可以通过现有工具显式创建和维护记忆文件。
4. 接入成功压缩后的快照刷新。

不读取、不迁移、不删除旧 `.agent/MEMORY.md` 或其他旧记忆文件。回滚时移除加载、注入和额外文件安全根即可；机器本地 Markdown 保留在磁盘，后续版本可重新启用或由用户手工处理。

## 待确认问题

无阻塞性开放问题。用户全局记忆、并发写入协调、容量配置化、文本搜索和自动提取均明确推迟到取得真实使用证据后的独立探索。
