## 背景

当前代码库中，`src/config/loader.ts` 作为底层配置模块依赖了 `src/interface/theme.ts`，造成了底层到表示层的反向引用；同时 `src/action/virtual-mcp.ts` 依赖了 `src/brain/contextLoader.ts`，打破了工具执行层和大脑上下文管理的明确分界。这两处“代码坏味道”违背了单向依赖树原则，埋下了循环引用的隐患。

## 目标与非目标

**目标:**
- 消除 `config -> interface` 的依赖。
- 消除 `action -> brain` 的依赖。
- 保持系统功能的绝对一致（不改变现有的任何交互体验、控制台输出的颜色与格式等）。

**非目标:**
- 引入重量级的依赖注入（DI）框架或事件总线（Event Bus）进行过度设计。
- 改变现有的系统级运行生命周期或核心逻辑。

## 架构决策

**1. `theme.ts` 下沉至基础设施层**
- **决策**：将原本位于 `src/interface/theme.ts` 的终端颜色高亮函数，平移下沉至 `src/utils/theme.ts`（或 `logger.ts`）。
- **理由**：由于 `theme` 提供的只是一组无状态的字符串渲染工具库（基于 `kleur` 或类似组件），它本质上是通用的基础 Utility。通过下沉，上层的所有模块（包括 `config`, `interface`, `action`, `brain`）都可以在不违反依赖规则的前提下自由调用它。

**2. `virtual-mcp.ts` 移除 `contextLoader` 依赖**
- **决策**：将 `virtual-mcp` 中对 `loadSkillContent` 的读取行为，向上提取。这可以通过在执行 `virtual-mcp` 时将需要的规则文本作为依赖参数传递进去（Dependency Injection/Method Injection）。
- **理由**：`action` 层的作用应当类似于无脑的执行器，需要操作或组装大脑的数据时，应由 `brain` 层在调度 `action` 前组装完毕并送出，以此彻底切断对底层存储或上下文逻辑的反向试探。

## 风险与权衡

- **大规模 Import 路径变更风险** -> 缓解策略：利用 TypeScript 编译器的强类型验证（`npx tsc --noEmit`），辅以 `npx vitest run test` 进行拦截，确保所有引用的相对路径被正确改写。
- **Git 文件跟踪丢失风险** -> 缓解策略：在文件系统中通过标准迁移路径直接移动，而不产生删除/新建，保留必要的跟踪历史（必要时使用 `git mv`）。但由于不写脚本的规范，我们将直接更改文件路径并靠全量替换修正。
