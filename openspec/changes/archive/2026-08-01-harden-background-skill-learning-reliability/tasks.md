## 1. 建立后台先读后写凭证

- [x] 1.1 新增 `src/core/usecases/brain/skill-review-read-ledger.ts`，定义带文件级说明和完整 TSDoc 的复盘级读取账本、规范化目标键、内容摘要及 `SkillMutationPrecondition`；账本必须绑定单个宿主验证 caller，关闭或取消后不可复用。
- [x] 1.2 修改 `src/core/usecases/brain/background-skill-agent.ts` 与 `src/adapters/tools/impl/skill/skill.ts`，只在 `load_skill` 真实成功后记录准确 `SKILL.md` 或 `file_path` 内容；失败结果、其他 Skill、主文件与支持文件之间不得互相充当凭证。
- [x] 1.3 修改 `src/core/domain/permissions/permission-types.ts` 与 `src/adapters/tools/permissions/skill-tool-authorization.ts`：由 `SkillManageAuthorizationAdapter` 在后台 caller 分支从读取账本签发 `SkillMutationPrecondition`，将其作为只读字段挂到现有 `SkillPermissionAnalysis`，随 `executionPlan` 冻结并通过 `ToolExecutionContext.permissionAnalysis` 交给工具；绑定 caller、action、name、filePath，缺失或不匹配时 fail-closed，不新增平行元数据通道，也不加入模型 Function Calling schema。
- [x] 1.4 修改 `src/adapters/tools/impl/skill/skill-manage.ts`，对 background_review 和长期技能融合 caller fail-closed 获取前置条件；前台调用保持原权限与批准契约，模型提交 fingerprint、origin 或 bypass 字段不得生效。
- [x] 1.5 在 `src/core/usecases/brain/skill-library.ts` 实现六种动作的读取规则：create 验证目标缺失；patch/edit 精确匹配目标；已有 write_file/remove_file 精确匹配支持文件；新支持文件要求主文件凭证；后台 delete 要求来源和 absorbedInto 主文件凭证。
- [x] 1.6 扩展 `test/core/usecases/brain/background-skill-agent.test.ts`、`test/adapters/tools/skill-tools.test.ts`、`test/adapters/tools/skill-tool-authorization.test.ts` 和 `test/contract/agent-managed-skills.test.ts`，覆盖盲写拒绝、错误文件凭证拒绝、新建例外、合并双凭证、模型伪造和前台不受影响。

<!-- checkpoint: npx vitest run test/core/usecases/brain/background-skill-agent.test.ts test/adapters/tools/skill-tools.test.ts test/adapters/tools/skill-tool-authorization.test.ts test/contract/agent-managed-skills.test.ts -->

## 2. 在 SkillLibrary 写入边界实施并发校验

- [x] 2.1 修改 `src/config/application-paths.ts` 增加应用数据目录下独立的 `skillLocksDir`（`resolve(userConfigDir, '.locks', 'skills')`），新增 `src/core/usecases/brain/skill-mutation-lock.ts` 作为“规范化 Skill 名 -> 锁文件”的薄包装：锁文件用规范化名称的稳定 SHA-256 命名，组合复用 `src/core/usecases/security/FileLockManager.ts` 的可取消进程内写锁和 `src/utils/cross-process-lock.ts` 的 `CrossProcessLockManager`，不得重写 `wx`、token/PID、陈旧回收、10 秒有界等待或 token 匹配释放协议；在 `src/index.ts` 等组合根向 `SkillLibrary` 注入路径与锁管理器。
- [x] 2.2 修改 `SkillLibrary.manage()` 及 `doCreate/doPatch/doEdit/doDelete/doWriteFile/doRemoveFile`：锁域固定为规范化 Skill 名，主文件与支持文件都归属所属 Skill 锁域；`delete(absorbedInto=...)` 对来源和吸收目标的规范化名称去重并按字典序获取两把锁、按相反顺序释放，所有调用路径遵守同一顺序；进入完整锁域后，在正文、usage、归档或 pending 副作用前重新解析目标并校验宿主前置摘要。
- [x] 2.3 为冲突结果定义稳定的 `read_before_write_required`、`stale_skill_read` 和 `skill_target_changed` 错误代码；冲突路径不得刷新缓存、增加 patch telemetry、创建 pending 或发送成功通知。
- [x] 2.4 保留临时文件加 rename 的原子替换，并在最接近替换的位置完成最后一次摘要检查；不得把非协作外部编辑器描述为绝对线性一致。
- [x] 2.5 更新 `test/core/usecases/brain/skill-library.test.ts` 和 `test/core/usecases/brain/skill-pending-store.test.ts`，覆盖两个实例竞争同名 Skill、主文件与支持文件共享锁域、双目标按规范化名称排序、反向参数并发不死锁、读取后变化、重读重试、目标由缺失变为存在、包装层超时/异常释放和批准重放的双层 stale 校验；复用现有锁基元测试，不重复断言其内部协议。

<!-- checkpoint: npx vitest run test/core/usecases/brain/skill-library.test.ts test/core/usecases/brain/skill-pending-store.test.ts test/contract/agent-managed-skills.test.ts -->

## 3. 将后台复盘改为单执行者队列

- [x] 3.1 修改 `BackgroundSkillReviewScheduler` 端口，令 `schedule()` 同步返回只读接受结果和任务标识；调用方只能在 `accepted=true` 时消费学习阈值，并为接口及返回类型补齐 TSDoc。
- [x] 3.2 重构 `src/core/usecases/brain/background-skill-review.ts`：用不可变请求 FIFO、单个活动任务和私有 drain 循环替换“每次 schedule 立即 runReview”的 `activeTasks` 模式，前一任务清理完成前不得启动下一任务。
- [x] 3.3 实现关闭状态机：先停止接收并让 schedule 返回未接受，再丢弃未启动请求、取消活动任务并有界等待；失败或 no-op 后必须继续 drain，关闭后不得重新启动。
- [x] 3.4 增加 queue depth、taskId、accepted/rejected、started/completed/failed/cancelled 的结构化日志，不记录完整轨迹或工具结果正文。
- [x] 3.5 更新 `test/core/usecases/brain/background-skill-review.test.ts` 和 `test/integration/background-skill-isolation.test.ts`，使用可控 Promise 验证 FIFO、最大并发为 1、失败后继续、关闭丢弃、关闭后拒绝和不可变入队快照。

<!-- checkpoint: npx vitest run test/core/usecases/brain/background-skill-review.test.ts test/integration/background-skill-isolation.test.ts -->

## 4. 持久化学习节奏并避免前台重复沉淀

- [x] 4.1 新增 `src/core/domain/skill-learning-cadence.ts`，定义版本化 `SkillLearningCadenceState`、深复制和 fail-closed normalize；字段使用 `accumulatedToolResponseIterations`，不得继续使用暗示所有模型循环的名称。
- [x] 4.2 修改 `src/core/domain/context.ts` 与 `src/core/usecases/brain/ContextRepository.ts`，在新版会话快照中保存学习节奏；旧快照或非法字段恢复为零并记录诊断，不能阻止消息、挂起交互和合法延续状态恢复。
- [x] 4.3 修改 `src/core/usecases/plugins/SkillLearningPlugin.ts`，从 SessionContext 恢复累计值；成功逻辑任务按 `toolIterationCount` 增量，调度接受后只减去一个阈值并保留余数，调度拒绝或同步异常时保持累计值，异步失败不自动返还。
- [x] 4.4 在插件 `AfterTool` 中解析前台 `skill_manage` 的真实 `success/staged/error` 结果，只让 success/staged 标记当前逻辑任务已沉淀；不得依据模型文本或失败调用设置标志，也不得清除此前任务的累计值。
- [x] 4.5 扩展 `src/core/domain/skill-learning-continuation.ts` 及快照 normalize，使前台沉淀标志跨等待用户交互恢复；旧延续版本按 false 迁移或 fail-closed 处理，并测试等待前、等待后和恢复失败三条路径。
- [x] 4.6 更新 `test/core/usecases/plugins/SkillLearningPlugin.test.ts`、`test/contract/session-persistence.test.ts` 和 `test/integration/skill-learning-loop.test.ts`，覆盖 9 个工具型响应加最终回答只计 9、并行工具只计 1、跨重启累计、阈值余数、同步拒绝不丢计数、异步失败不返还及前台成功/暂存/失败去重。

<!-- checkpoint: npx vitest run test/core/usecases/plugins/SkillLearningPlugin.test.ts test/contract/session-persistence.test.ts test/integration/skill-learning-loop.test.ts -->

## 5. 静态检查与整体验收

- [x] 5.1 运行测试类型检查、生产构建和 ESLint，修复调度返回类型、快照版本、公共领域类型及锁模块的所有静态问题，并核对新增或修改代码满足项目注释规范。
- [x] 5.2 执行严格 OpenSpec 校验，确认本 change 不引入记忆计数、持久后台作业队列、内容扫描或通用工具事务。

<!-- checkpoint: npm run test:typecheck -->
<!-- checkpoint: npm run build -->
<!-- checkpoint: npm run lint -->
<!-- checkpoint: openspec validate harden-background-skill-learning-reliability --type change --strict -->
