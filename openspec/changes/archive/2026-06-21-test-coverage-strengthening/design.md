# 架构设计：核心领域服务与基础工具单元测试覆盖率补强

## 背景

六边形重构解耦了系统的层级结构，但核心用例层（`core/usecases`）覆盖率偏低（约 47.58%），且 `SecurityService`（46.87%）、`RuleManager`（56%）和控制台渲染器 `CliFacade`（6.5%）存在大片未被覆盖的测试死角，给后续系统的多智能体协同演进埋下了质量隐患。此外，依赖物理 I/O 读写的产品代码在并发测试中容易产生目录及文件竞态冲突，需要通过纯化 Mock 或是测试隔离沙箱予以治理。

## 目标与非目标

**目标:**
1. **核心重灾区与安全性核心服务达标**：分别补齐缺失的靶向测试用例，使以下模块的 Statement 覆盖率在 hexagonal 重构后达标：
   - `CompactionService` 最低 Statement 覆盖率线：**70%**（重点覆盖压缩熔断等边缘分支）；
   - `ContextRepository` 最低 Statement 覆盖率线：**80%**（重点覆盖基本状态落盘与回滚回溯）；
   - `ToolDispatcher` 最低 Statement 覆盖率线：**85%**（重点覆盖大输出 offloading 与 JIT 加载）；
   - `SecurityService` 最低 Statement 覆盖率线：**85%**（重点覆盖命令前缀白名单校验、路径放行及临时白名单时效管理）；
   - `RuleManager` 最低 Statement 覆盖率线：**80%**（重点覆盖全局及局部项目伴生规则重载逻辑）；
   - `core/usecases` 整体 Statement 覆盖率拉高至 **80%** 以上。
2. **终端渲染流式功能保障**：为 `CliFacade.handleAgentEvent` 补充单元测试，验证其在控制台捕获 stdout 渲染行为的正确性。
3. **消除并发竞态**：彻底避免测试在并发模式下发生物理文件及目录读写冲突。

**非目标:**
1. **不改动任何生产代码的业务决策逻辑**。
2. **不使用进程全局 `process.chdir()` 的方式进行物理隔离**，防止多线程测试路径错乱。
3. **不对已作废或无用历史文件补充多余测试**。

## 物理文件变动清单

本次补强将引入以下全新的测试文件（不涉及无用或已废弃文件的测试编写）：
1. `test/brain/CompactionService.test.ts` (新建)：验证历史记录压缩与提取。
2. `test/brain/ContextRepository.test.ts` (新建)：验证上下文落盘与回退。
3. `test/brain/ToolDispatcher.test.ts` (新建)：验证 JIT 工具调度与大输出 offloading。
4. `test/brain/SecurityService.test.ts` (新建)：验证白名单管理及生命周期。
5. `test/brain/RuleManager.test.ts` (新建)：验证项目伴生规则重载。
6. `test/interface/CliFacade.test.ts` (新建)：验证控制台 UI 事件流渲染。

## 架构决策

### 决策 1：物理隔离临时沙箱与可选工作区参数注入
- **决策内容**：针对 `ContextRepository` 和 `ToolDispatcher` 原本隐式依赖 `process.cwd()` 寻找工作目录的现状，决定在构造函数中引入可选的 `workspacePath?: string` 参数。
- **实施路径**：若传入 `workspacePath`，则相关文件寻路及沙箱操作重定向至该路径；否则默认回退使用 `process.cwd()`。在测试用例的 `beforeEach` 中，调用 `fs.mkdtempSync` 创建物理隔离的随机临时目录并传入，并在 `afterEach` 中递归清理，彻底规避并行测试环境下的物理 I/O 冲突。

### 决策 2：CliFacade 进程强退全局拦截
- **决策内容**：由于 `CliFacade` 内部指令（如 `exit`）含有直接杀死 Node 进程的 `process.exit(0)`，在 Vitest 中直接调用这些分支会导致整个测试进程夭折。
- **实现手段**：在 `CliFacade` 单元测试的 `beforeEach` 中，使用 `vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)` 建立强退全局拦截墙，拦截强退信号并进行安全断言，防止线程崩溃。

### 决策 3：拦截 process.stdout 断言 UI 渲染行为
- **决策内容**：UI 层属于 Driving Adapter，测试其 handleAgentEvent 在控制台的 stdout 渲染输出是拉高其覆盖率的最简路径。
- **实现手段**：实例化一个 Mock `EventEmitter` 扮演 `SessionManager` 发射 `agent_event`，并在测试中劫持 `process.stdout.write` 或 `console.log`，将输出收集起来再使用 `toContain` 对 `thinking`、`content` 等各事件渲染出的字符做纯文本断言。

### 决策 4：SecurityService 单例状态重置与白名单文件路径可配化
- **决策内容**：`SecurityService` 采用单例模式且硬编码了其保存路径为 `.agent/allowed_commands.json`。测试中多个用例共享同一个内存实例会导致白名单数据污染，且硬编码路径妨碍了在隔离沙箱中测试。
- **实施路径**：
  1. 为 `SecurityService` 新增一个测试专用的静态重置方法：
     ```typescript
     /** @internal @VisibleForTesting */
     public static resetInstance(): void {
       SecurityService.instance = null as any;
     }
     ```
     并在测试套件的 `afterEach` 中调用以清空单例。
  2. 微调 `SecurityService.getInstance` 方法，允许在未初始化时传入可选的 `configPath?: string` 参数用于重定向白名单文件的保存路径（或在构造中支持该配置），确保测试白名单能落盘在 `mkdtemp` 的沙箱目录中。

## 风险与权衡

- **[风险 1] UI 单元测试的 ANSI 终端转义字符断言失效**：
  - *分析*：终端输出中常包含类似 `\x1b[33m` 的颜色格式字符，在不同的操作系统终端下断言容易失效。
  - *缓解策略*：在断言 CliFacade 渲染输出时，使用简单的正则表达式或清洗函数剥离 ANSI 终端颜色代码，只对过滤后的纯文字做 `toContain` 匹配断言。
- **[风险 2] process.stdout.write 拦截导致测试报告被吞没**：
  - *分析*：如果全局 Mock `process.stdout.write` 后没有正常还原，会直接破坏 Vitest 框架向控制台打印测试报告的行为，导致测试日志空转。
  - *缓解策略*：在单元测试的 `afterEach` 钩子中，必须无条件调用 `vi.restoreAllMocks()` 或还原原始的 `process.stdout.write`。
- **[风险 3] 单例状态污染与物理文件泄露**：
  - *分析*：虽然注入了沙箱，但若 `SecurityService` 没有正确在 `afterEach` 中重置单例，后置单测依然会读取前置单测写入内存的数据。
  - *缓解策略*：强制在 `SecurityService` 测试的 `afterEach` 自动调用 `SecurityService.resetInstance()` 清理内存，并递归删除临时沙箱目录。
