# Design - Sub-Agent Session Isolation

本设计方案阐述如何通过在 `ContextRepository` 持久化组件中引入瞬态标识（isTransient）实现临时会话物理文件隔离，同时保障构造签名的向后兼容性。

## 1. 详细设计实现

### A. ContextRepository 构造签名向后兼容改造
为保证现有调用形式（无参数、单参数或双参数 `new ContextRepository(...)`）完全不受干扰，新增的 `isTransient` 参数必须且仅能声明在构造签名参数的最末尾，并设置默认值为 `false`。

在 [ContextRepository.ts](file:///d:/Projects/MyAgent/src/core/usecases/ContextRepository.ts) 中：
```typescript
export class ContextRepository {
  /**
   * 实例初始化。
   *
   * @param context - 会话上下文管理实例
   * @param workspacePath - 可选的工作区根路径，用于重定向持久化状态存储路径
   * @param isTransient - 可选。是否为临时或瞬时会话，若为 true 则在 saveState 时不会物理落盘
   */
  constructor(
    private context: SessionContext,
    private workspacePath?: string,
    private isTransient = false
  ) {}
  
  ...
}
```

### B. saveState() 拦截控制
在 `ContextRepository.saveState()` 方法的开头引入防御式拦截，判定若为瞬态会话则直接执行 `no-op` 退出：
```typescript
  public async saveState(): Promise<void> {
    if (this.isTransient) {
      return;
    }
    // 原始写盘逻辑
    ...
  }
```

### C. 子智能体实例注入
在 [session.ts](file:///d:/Projects/MyAgent/src/core/usecases/session.ts) 中，自省提炼子智能体对应的实例化 `subContextRepo` 将被显式标记为 `isTransient = true`，以规避其后台自旋迭代时自动写盘：
```typescript
    // 实例化隔离的四大领域服务，并将 isTransient 显式传为 true
    const subRuleManager = new RuleManager(subContext);
    const subContextRepo = new ContextRepository(subContext, undefined, true);
    const subToolDispatcher = new ToolDispatcher(subContext);
    const subCompactionService = new CompactionService(subContext, this.driver, subContextRepo);
```

## 2. 测试策略
- **单元测试补强**：在 `test/brain/ContextRepository.test.ts` 中新增单元测试，校验当 `isTransient` 选项被开启时，执行 `saveState()` 确实不会在对应目录下创建文件，且 `loadState()` 行为保持正常。

## 3. 测试全局物理沙箱隔离设计

为解决 Vitest 单元测试运行期间，因没有 Mock 路径导致物理写盘污染项目根目录下 `.agent/MEMORY.md` 及 `.agent/vectordb.json` 的问题，设计如下：
- **全局环境隔离脚本 (test/setup.ts)**：
  - 在所有测试执行前（加载时），在项目内部已被 Git 忽略的 `.myagent/temp/` 目录下，利用 `fs.mkdtempSync` 创建专属的项目内虚拟测试工作区。
  - 在临时工作区下自动建立虚拟的 `.agent` 目录，并硬编码写入固定的测试 facts 数据（包含项目基础架构的核心事实）以建立测试版 `MEMORY.md`，保证测试跨机器 100% 可复现。
  - 将 `process.env.AUTHORIZED_WORKSPACE_DIR` 全局指向该临时工作区。
  - 注册 Vitest 的全局 `afterAll` 钩子，在所有测试执行结束后，静默清理并销毁该临时工作区及其下的全部临时物理文件。
- **Vitest 配置对接 (vitest.config.ts)**：
  - 在测试配置中注册 `setupFiles: ['./test/setup.ts']`。

## 4. [调试修正] ContextRepository 沙箱路径映射重构

在 `/openspec-debug` 结构化调试排查中确认：
- **路径重定向盲区**：`ContextRepository.ts` 内部的 `saveState()` 与 `loadState()` 路径构建逻辑中未读取 `process.env.AUTHORIZED_WORKSPACE_DIR` 环境变量，导致会话状态文件即使在 `test/setup.ts` 拦截状态下依然直接写入物理工作区物理根目录。
- **重构方案**：将 `saveState()` (L33) 及 `loadState()` (L55) 的路径确定逻辑，全部变更为与项目全局统一的 `this.workspacePath || process.env.AUTHORIZED_WORKSPACE_DIR || process.cwd()`，使沙箱的隔离对于 `ContextRepository` 完美生效。

## 5. [调试修正] AgentTracer 沙箱路径映射重构

在第二次 `/openspec-debug` 结构化调试排查中确认：
- **Trace 路径重定向盲区**：`session.ts` 内部在构造函数（L117）、状态重置（L261）以及子 Agent 实例化（L607）这三处，全部硬传了 `process.cwd()` 作为 `AgentTracer` 的工作目录，导致测试运行时不断产生物理痕迹 `.myagent/traces/`。
- **重构方案**：在 `session.ts` 内部的这三处实例化 `AgentTracer` 前，统一变更为优先读取 `process.env.AUTHORIZED_WORKSPACE_DIR || process.cwd()` 环境变量，使其能够受到测试沙箱的全局重定向拦截。

