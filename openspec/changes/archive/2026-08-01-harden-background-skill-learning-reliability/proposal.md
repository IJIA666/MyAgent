## 改造原因

后台 Skill 学习已经具备工具收窄、所有权校验和原子文件替换，但仍把“提示模型先读取”“同一会话通常不会并发”和“进程不会在阈值前重启”当作隐含前提。当前实现没有强制修改前读取准确目标，多个复盘可同时运行，读取与写入之间缺少版本校验，累计阈值只存在插件内存中，而且前台已经成功沉淀 Skill 的任务仍会推进后台复盘计数。这些缺口会造成陈旧内容覆盖、重复复盘和学习节奏丢失。

## 变更内容

- 为每次隔离复盘建立独立的 Skill 读取账本。后台修改已有 `SKILL.md` 或支持文件前必须在同一次复盘中读取对应目标；创建新 Skill 不要求预读，新建支持文件必须先读取所属 `SKILL.md`。
- 在实际写入边界携带并校验读取时的内容指纹；目标在读取后发生变化时拒绝本次写入并要求重新加载，模型参数不得伪造或绕过该前置条件。
- 将后台复盘调度改为单会话单执行者的先进先出队列，任一时刻最多运行一个复盘；会话关闭时取消活动任务并丢弃尚未开始的任务。
- 保留 MyAgent 现有的“包含非空 `tool_calls` 的模型响应次数”计量语义，明确它不是模型请求总数；将未达到阈值的累计值写入会话快照，恢复会话后继续累计。
- 只有调度器同步接受复盘请求后才消费阈值，并保留超过阈值的余数；请求被拒绝或同步排队失败时不得丢失累计值，已经接受后发生的异步模型失败仍按尽力而为处理并记录诊断。
- 当前逻辑学习单元若已经通过前台 `skill_manage` 成功写入或暂存 Skill，则该单元不再推进后台复盘计数，但不得清除此前其他任务留下的累计值；失败的前台写入不享受该豁免。

## 业务能力

### 新增业务能力

- `background-skill-learning-reliability`: 定义后台 Skill 修改的先读后写、并发一致性、串行调度和持久化学习节奏。

### 修改业务能力

- `session-persistence`: 会话快照新增可校验的 Skill 学习累计状态，并在恢复时 fail-closed 加载。

## 影响范围

- 后台复盘调度及受限工具包装：`src/core/usecases/brain/background-skill-review.ts`、`src/core/usecases/brain/background-skill-agent.ts`。
- Skill 读取、写入前置条件和文件一致性：`src/adapters/tools/impl/skill/skill.ts`、`src/adapters/tools/impl/skill/skill-manage.ts`、`src/core/usecases/brain/skill-library.ts`。
- 学习计数与前台 Skill 变更识别：`src/core/usecases/plugins/SkillLearningPlugin.ts` 及其端口契约。
- 会话状态及快照迁移：`src/core/domain/context.ts`、新增的学习节奏领域值对象、`src/core/usecases/brain/ContextRepository.ts`。
- 后台复盘、并发写入、会话恢复和前台去重相关的单元、契约与集成测试。
