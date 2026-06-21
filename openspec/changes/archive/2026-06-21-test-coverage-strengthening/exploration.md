# 探索主题: 核心领域服务与基础工具单元测试覆盖率补强

## 1. 问题定义

在完成六边形架构解耦后，系统划分为核心层（Core）与适配层（Adapters）。虽然整体单元测试全部通过且拥有 100% 绿灯质量，但根据 Vitest 覆盖率分析，当前系统仍存在多处核心业务逻辑与常用基础工具的测试缺口（整体 Statement 覆盖率约 49%），这给后续的功能演进与重构埋下了回归隐患。

本主题旨在针对这些“被遗忘的测试死角”进行结构性分析，并确定后续的补强路线。

## 2. 关键发现与调研结果

### 代码库现状

通过执行 `npx vitest run --coverage`（数据采集时间点：2026-06-21 13:40:00，hexagonal 重构完成后），我们对当前代码库的测试覆盖率现状进行了量化审计，主要发现以下几个重灾区：

1. **`core/usecases` 领域服务核心逻辑轻微缺失测试（最关键的缺口）**：
   - **现状与定位**：该目录目前拥有 **47.58%** 的 Statements 覆盖率。这里是整个项目的核心调度枢纽，`SessionManager`、`AgentLoop` 都承载于此，测试密度理应最高。
   - **测试盲区**：虽然当前 Change 新增的 `loopback.test.ts` 已经覆盖了自唤醒锁下沉逻辑的核心路径，且移入核心的五个拦截插件自带部分覆盖，但 `AgentLoop` 本身的推理迭代逻辑（`chat` 中的 tool_calls 处理分支、大模型异常拦截分支）、`CompactionService`（上下文压缩服务）、`ContextRepository`（落盘/回滚）、`ToolDispatcher`（工具输出防爆/JIT 注入）、`SecurityService`（白名单管理）与 `RuleManager`（规则重载）等大部分分支依然处于未被单测直接覆盖的状态。
2. **`adapters/input/interface` 的结构性覆盖盲区**：
   - **现状与定位**：目前该目录的 Statements 覆盖率仅为 **6.5%**。
   - **结构性原因**：`CliFacade` 作为 UI 渲染层与系统终端控制台高度强耦合（依赖 stdin/stdout 物理状态），传统的集成测试和 Mock 极其困难。
   - **测试补强可行性**：在六边形重构后，`CliFacade` 本身已经被成功降级为纯粹的“事件渲染器”。理论上，我们可以通过 Mock `SessionManager` 发射 `agent_event` 广播事件流，针对 `handleAgentEvent` 内的各个 case 分支（如渲染 thinking, content, error, suspend, complete）补写单元测试，并断言控制台的渲染行为，即可低成本拉高覆盖率并确保渲染行为一致性。
3. **测试并发写竞态风险**：
   - `ContextRepository.ts` 和 `ToolDispatcher.ts` 的业务逻辑均高度依赖于 `process.cwd()` 下的物理文件读写（如 `.myagent/sessions`、`.myagent/temp`）。如果在测试中直接读写这些默认路径，不仅会污染生产环境文件，还会在 Vitest 并发测试中引发测试写竞态。

### 核实与洞察

- **覆盖率长效监测**：将 `@vitest/coverage-v8` 引入项目开发依赖是一项非常成功的决策。它可以在每个 Change 落地后留下基准快照，使得我们在后续迭代中可以随时监测测试覆盖率的涨跌趋势，建立长效质量监控。
- **沙箱隔离手段**：对于依赖物理 IO 的 `ContextRepository` 和 `ToolDispatcher`， we 已验证在单元测试的 `beforeEach` 中使用 `fs.mkdtempSync` 创建独立的沙箱目录并重定向工作区目录是 100% 消除并发执行竞态的成熟模式。
- **UI 事件 Mock 策略**：针对 `CliFacade` 结构性难以测试的问题，使用 Node 原生的 `EventEmitter` 进行 `agent_event` 的 Mock 派发，能低成本完成对控制台输出的流式渲染及阻塞中断分支验证。

## 3. 方案对比与推荐方向

| 评估维度 | 方案 A：单独立项，本期集中实施单元测试补强 (推荐) | 方案 B：暂不起战役，随后续 Change 逐步伴随补充 |
| :--- | :--- | :--- |
| **测试精准度** | **高 ✓**：可针对特定分支、错误处理（如写盘失败、JIT寻路截止、压缩失败熔断）进行精准打桩。 | **中 ✗**：测试编写依赖后续变更，短期内核心 usecases 的特定异常边界无法得到覆盖。 |
| **运行效率** | **极快 ✓**：集中编写的单测执行时间通常在 10ms - 50ms 内，无需真实调用 LLM，极其高效。 | **较慢 ✗**：散落于后续各集成测试中，大流程拉长测试耗时。 |
| **逻辑保护价值** | **高 ✓**：核心 usecase 层在完成六边形解耦后结构稳定，本期主动补全可以为后续多智能体等核心变更奠定坚实的质量防线。 | **中 ○**：由于这些底层核心服务在功能稳定期内变动频率较低，其即时回归风险相对小，可随未来相关模块发生大变更时被动伴随补充。 |
| **维护与修改成本** | **低 ✓**：与六边形架构中高内聚的 usecase 层直接对齐，逻辑修改时单测易重构。 | **高 ✗**：零散补充缺乏系统性的路径隔离与 Mock 规范，易产生用例冗余。 |

**共识结论与后续路径**：
采纳 **方案 A**。在当前 hexagonal 重构封存后，**作为下一个 change 单独立项补强**，集中提升核心层服务及 UI 渲染层单测覆盖率。

我们为核心重灾区与安全性核心服务设定以下精细化的最低量化质量达标红线：
- **`CompactionService` 最低 Statement 覆盖率线：70%** (覆盖主逻辑及压缩熔断等边缘分支)；
- **`ContextRepository` 最低 Statement 覆盖率线：80%** (覆盖基本状态落盘与回滚回溯)；
- **`ToolDispatcher` 最低 Statement 覆盖率线：85%** (覆盖大输出 offloading 与 JIT 加载)；
- **`SecurityService` 最低 Statement 覆盖率线：85%** (覆盖命令前缀白名单校验、路径放行及临时白名单时效管理)；
- **`RuleManager` 最低 Statement 覆盖率线：80%** (覆盖全局及局部项目伴生规则重载逻辑)；
- **`core/usecases` 整体 Statement 覆盖率线：80% 以上**。

后续补强重点锁定在：
1. **测试沙箱化与路径隔离**：在 `CompactionService`, `ContextRepository`, `ToolDispatcher` 单元测试中，通过可选的 `workspacePath` 或 `appConfig` 注入动态生成的 `fs.mkdtempSync` 隔离文件夹，消除物理 IO 的并发写竞态风险。
2. **靶向补全核心逻辑分支**：补全 `AgentLoop.chat` 中对于 tool_calls 触发流程、大模型异常熔断、以及 `CompactionService` 压缩限制、`SecurityService` 临时放行机制、`RuleManager` 规则热重载等分支的单元测试。
3. **UI 渲染器测试**：为 `CliFacade` 编写单元测试，Mock 派发完整的 `AgentEvent` 流，验证控制台输出的正确性与阻塞/继续等交互逻辑。

## 4. 约束、风险与未知项

- **UI 单元测试的 process.exit() 强退风险**：在测试 `CliFacade` 的输出和指令退出逻辑时，若执行到 `process.exit(0)` 分支会导致整个 Vitest 测试进程强退死亡。**必须**在 `beforeEach` 中使用 `vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)` 进行全局强退拦截。
- **全局 process.chdir() 竞态风险**：由于 Vitest 默认并行运行多个测试文件，使用 `process.chdir()` 修改当前进程的工作目录会导致并行的其他测试文件相对路径解析彻底崩溃。**绝对禁止**使用 `process.chdir()`，而应全面使用配置/构造注入临时工作区路径。
- **物理文件的测试清理**：临时沙箱文件夹必须在测试完毕后在 `afterEach` 中通过 `rmSync` 彻底递归删除，以防物理磁盘空间泄漏。

## 5. 否决方案

- **方案 B (暂不起战役，随改随补)**：该方案虽然符合低频改动模块的防御逻辑，但会导致底座 usecases 和安全服务（`SecurityService`）长时间存在测试盲区，隐患防范迟缓，故予以否决。
- **方案 C (模拟端到端 ChatUseCase 的集成测试)**：该方案因为运行效率低下、分支控制薄弱、易产生外部物理文件污染且与六边形分层隔离理念相悖，被作为核心覆盖手段予以否决。仅保留作为大流程保障。
