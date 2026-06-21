# 提案：核心领域服务与基础工具单元测试覆盖率补强

## 改造原因

六边形架构解耦重构完成后，系统虽然保障了编译与现有测试的 100% 绿灯，但底座核心层服务与常用基础工具存在大量的测试分支盲区。
- **核心 usecases 覆盖率低**：`CompactionService`、`ContextRepository` 和 `ToolDispatcher` 承载了底座的重难点状态与文件 I/O 调度，但目前整体 Statements 覆盖率仍低于 50%，亟需补强以防范未来迭代时的回归风险。
- **安全服务处于零直接单测状态**：作为安全控制中枢的 `SecurityService` 只有 46.87% 的覆盖率，对其白名单持久化和时效管理缺乏直接单元测试保障。
- **UI facade 结构性未测试**：由于和 stdin/stdout 强绑定，`CliFacade` 目前 Statements 覆盖率仅为 6.5%，对流式事件渲染和阻塞中断的各 case 分支缺乏质量断言。

本提案旨在单独立项，集中攻克上述 6 个核心组件的单元测试缺口，筑牢架构质量底座。

## 变更内容

本期变更属于**技术质量与单测补强**，不改动任何生产业务逻辑，主要实施以下测试变动及可测试性改进：
1. **新建靶向单元测试**：针对 `CompactionService`、`ContextRepository`、`ToolDispatcher`、`SecurityService` 与 `RuleManager` 五大核心服务编写高精细度单测，补齐各分支路径和异常分支。
2. **轻量级可测试性改进**：
   - 允许对 `ContextRepository` 与 `ToolDispatcher` 注入可选的工作区根路径，避免强依赖全局 `process.cwd()`；
   - 在 `SecurityService` 中暴露供单元测试专用的静态重置方法 `resetInstance()` 极其白名单配置文件路径的重定向能力，以防止单例状态残留与测试文件污染。
3. **重构测试沙箱隔离**：为测试物理读写的用例设计以注入（配置/参数）形式隔离的 `fs.mkdtempSync` 临时沙箱，禁止在多线程测试中修改进程级 `process.chdir()`，彻底规避并行写竞态。
4. **补充 UI 事件流渲染测试**：为 `CliFacade` 补充测试用例，通过 Mock 派发 `AgentEvent` 流，验证其对 thinking、content、error、suspend、complete 事件的 stdout 渲染行为，并在 beforeEach 中全局拦截 `process.exit(0)` 防范测试进程意外死亡。

## 业务能力

### 新增业务能力
- test-coverage-strengthening

### 修改业务能力
- （无）

## 影响范围

- **受影响代码**：主要在 `test/` 目录下新增测试代码。为了实现测试隔离与可测试性，会对 `src/` 下的核心类（如 `SecurityService`、`ContextRepository` 与 `ToolDispatcher`）做轻量且安全的接口微调，但不改动任何既有的业务决策逻辑。
