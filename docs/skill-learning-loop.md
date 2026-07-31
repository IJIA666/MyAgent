# Agent Skill 学习闭环

## Skill 与 Memory

Skill 保存的是可执行、可验证、可复用的程序性工作方法，通常包含触发条件、步骤、工具使用和结果检查。Memory 保存的是用户、项目或历史事实，供后续对话恢复背景。Skill 可以被 Agent 当作工作流说明执行；Memory 不应被当成自动执行授权，也不负责维护工具操作步骤。

两者的持久化和投影相互隔离：Skill 不写入会话 Memory，后台 Skill Review 也不读取父会话的 Memory 快照。

## 目录布局

用户 Skill 及生命周期设施位于应用数据根：

```text
skills/
├── <skill>/SKILL.md
├── .usage.json
├── .curator-state.json
├── .archive/
└── .curator-backups/
pending/skills/
logs/curator/<run-id>/{run.json,REPORT.md}
```

项目 Skill 位于项目配置目录。同名时项目 Skill 覆盖用户 Skill；后台 Review 和 Curator 不得修改项目 Skill 或被项目同名 Skill 遮蔽的用户 Skill。

## Skill 包和管理动作

每个包必须包含带合法 `name`、`description` frontmatter 的 `SKILL.md`，并可包含 `references/`、`templates/`、`scripts/`、`assets/`。第一版只读写 UTF-8 文本，不提供二进制或 base64 写入路径。`SKILL.md` 最多 100,000 字符，单个支持文件按 UTF-8 编码最多 1 MiB。

`skill_manage` 每次只执行一个动作：

- `create`：创建完整 Skill。
- `patch`：唯一匹配的定点替换；多处替换需显式 `replaceAll=true`。
- `edit`：替换完整 `SKILL.md`。
- `delete`：前台在 destructive 权限确认后硬删除；后台融合必须提供已存在的 `absorbedInto`，并执行可恢复归档。
- `write_file`：写入白名单目录中的支持文件。
- `remove_file`：删除白名单目录中的支持文件。

`origin` 不属于模型 schema。它由统一 ToolGateway 根据宿主验证的 caller 派生，模型不能伪造。`delete` 始终不是 ordinary edit，默认需要 destructive 询问。Plan 模式、显式 deny、受保护资源和项目覆盖边界不因 Skill 工具而放宽。

每次动作独立提交。第一版不提供跨多个 `skill_manage` 调用的事务或统一回滚；前序动作成功后，后续动作失败不会撤销前序动作。

## 后台学习触发

主 Agent 的 RunEnd 只安排后台复盘，不等待复盘完成。默认累计 10 次“包含非空 `tool_calls` 的模型迭代”后触发一次 Review，跨 run 累计，触发后归零。10 是对齐 Hermes 的学习基线，便于初期较快建立 Skill 库；用户可提高阈值或关闭后台 Review 来控制模型成本。

统计定义：

- `toolIterationCount`：模型响应含非空 `tool_calls` 的轮数，即使同一响应同时含 content 也计入。
- `requestedToolCallCount`：这些轮次请求的真实工具调用总数，并行调用逐个计数。
- `hasFinalResponse`：只有最后一次不含工具调用、并已提交到历史的完整 assistant 回复才为 true。

只有 `terminalStatus=completed`、`hasFinalResponse=true` 且没有等待人机交互的 run 才累计。缺少 RunEnd summary、失败、中止、拒绝或等待交互都不触发。

Review 使用独立 SessionContext、临时 ContextRepository、空 Memory 投影、空插件注册表和独立取消器，工具上限是父工具面与 `load_skill`/`skill_manage` 的交集。主回复先交付，后台成功或暂存结果再以非阻塞通知出现。

Review 判断知识时遵循：

- 跨实例性：不依赖本会话独有绝对路径、时间戳或偶然版本。
- 验证性：包含可执行的前置检查和结果验证。
- 正向路径优先：多次尝试后只保存已经验证的成功路径；失败原因只有验证后才可形成带条件的 pitfall。

完整复盘后没有可复用知识是合法 no-op，不要求最低更新数、最低创建数或多数运行必须修改。

## 写入批准

`skills.writeApproval=false` 是默认值。开启后，后台非 delete 写入只生成一条独立 pending，不修改目标 Skill。使用 `/skill pending`、`diff`、`approve`、`reject` 管理；批准时重新经过 ToolGateway 并检查暂存后的目标 fingerprint，成功后才可加载。

## Usage、所有权和降级

`.usage.json` 保存 view/use/patch 计数、最近活动时间、生命周期、pinned 和策略所有权：

- 后台创建自动成为 agent-created。
- 前台创建和手工文件默认 unmanaged。
- `/curator adopt <name>` 只把未遮蔽的活动用户 Skill 移交给 Curator；`createdBy=agent` 表示后续管理权限，不声称历史作者事实。
- pinned Skill 不允许后台 Review 修改、自动迁移或 LLM 融合。

usage sidecar 的完整读改写持有跨进程文件锁。损坏时 Skill 正文仍可读，但遥测和所有权 fail closed 退化为空，自动维护停止，并产生单次非阻塞通知。系统不会自动从备份恢复、猜测作者或自动 adopt；用户应先检查 `/curator status`，再显式回滚备份或修复后重新 adopt。

## Curator

确定性 Curator 默认启用：

- 自动检查间隔：168 小时。
- 最小空闲：2 小时。
- 30 天无活动标记 stale。
- 90 天无活动归档完整包。
- never-used Skill 从 `createdAt` 计算完整宽限。
- LLM umbrella 融合默认关闭。

首次观察只写调度基线，不立即维护。候选扫描只是快照；每次真实 stale/archive 前会在 usage 锁内重新读取 ownership、pinned 和所有活动时间，并重新解析活动 Skill。并发 use、view、patch 或 pin 会取消过期候选。

每次 Curator 运行都会在日志目录生成机器可读 `run.json` 和用户可读 `REPORT.md`；基线、暂停、未到期、降级和完整 no-op 也会记录状态与有效配置，但不会伪造变更项。

`/curator run --dry-run` 只输出计划，不写 Skill、usage、state、archive 或 backup。真实变更前创建完整备份；备份失败时 fail closed。归档 Skill 可用 `list-archived` 和 `restore` 恢复；活动根或项目合并视图存在同名目标时拒绝恢复。`backup` 和 `rollback` 提供整批恢复能力。

显式 `/curator run --consolidate` 或配置 `curator.consolidate=true` 才启动最多 8 次迭代的隔离融合 Agent。它必须完整检查 managed、active/stale、非 pinned 候选，保护支持文件和相对链接；没有安全合理的 umbrella 融合时保持 no-op。
