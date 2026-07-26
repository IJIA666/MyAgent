## 改造原因

旧长期记忆运行时已连同 RAG、Embedding、VectorDB 和会话结束提炼模型一起移除。当前系统缺少一种简单、可审计且能够跨会话保留用户偏好、用户反馈、项目背景和外部引用的长期记忆能力。

现在需要在干净基线上增加 Markdown-first Auto Memory：以机器本地 Markdown 作为唯一事实源，启动时只加载有界索引，正文按需读取，并由当前主 Agent 使用现有标准文件工具维护。该能力不得重新引入数据库、向量索引、分块、语义召回或记忆专用模型。

## 变更内容

- 为每个 workspace-key 增加机器本地的项目记忆目录 `~/.myagent/projects/<workspace-key>/memory/`，包含有界 `MEMORY.md` 索引和 `topics/*.md` 主题文件。
- 固定支持 `user`、`feedback`、`project`、`reference` 四种主题 frontmatter 类型，并定义保存、排除、召回、命名、复用和忘记语义。
- 会话启动时读取一次 `MEMORY.md` 冻结快照；system prompt 只承载稳定的 Auto Memory 机制规则，当前项目实际 `memoryDir` 与索引作为独立、非持久化的 meta user context 进入模型请求，空索引仍提供目录以支持创建第一份记忆。
- 复用现有列举、读取、写入、编辑和删除文件能力，不新增专用 `memory` 工具；只为当前项目解析出的 memoryDir 增加精确读写边界。
- 成功提交上下文压缩后重新读取磁盘记忆；压缩失败或跳过时保持原快照。普通记忆写入不按次数触发快照刷新。
- 明确不迁移旧 `.agent/MEMORY.md`，不自动提取会话，不提供语义搜索、用户全局记忆或多进程写入合并保证。

## 业务能力

### 新增业务能力

- `markdown-first-long-term-memory`: 提供按项目隔离的 Markdown 长期记忆存储、分类、加载、请求注入、标准文件工具维护和忘记行为。

### 修改业务能力

- `application-data-layout`: 在统一项目数据根下增加 `memoryDir` 分类，并保持 workspace 配置目录不承载私有记忆。
- `base-security`: 允许标准文件工具在不扩大用户数据目录权限的前提下访问当前项目的精确 memoryDir。
- `context-compaction`: 在压缩成功后刷新长期记忆快照，失败或跳过时不改变快照。

## 影响范围

- 配置与组合根：`src/config/application-paths.ts`、`src/config/types.ts`、`src/config/loader.ts`、`src/index.ts`。
- 会话与请求组装：`src/core/domain/context.ts`、`src/core/usecases/engine/session.ts`、`src/core/usecases/engine/model-request-assembler.ts`。
- 提示词与压缩：`src/core/usecases/brain/prompts.ts`、`src/core/usecases/brain/CompactionService.ts`。
- 文件访问边界：`src/adapters/tools/impl/base.ts` 及现有标准文件工具的安全检查。
- 新增 Markdown 记忆加载、校验和快照模块及对应单元、契约和集成测试。
- 不增加生产数据库、Embedding、VectorDB、LanceDB、RAG、分块依赖或记忆专用模型配置。
