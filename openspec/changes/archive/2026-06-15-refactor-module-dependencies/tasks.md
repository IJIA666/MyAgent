## 1. Theme 模块下沉解耦

- [x] 1.1 将 `src/interface/theme.ts` 移动（或复制并在旧处删除）至 `src/utils/theme.ts`。
- [x] 1.2 全局搜索并更新所有对 `theme` 的引用路径。例如将 `import { theme } from '../interface/theme.js'` 修改为 `import { theme } from '../utils/theme.js'`。
- [x] 1.3 修复 `config/loader.ts` 中的依赖路径，使其从依赖 interface 层变为依赖 utils 层。

<!-- checkpoint: npx tsc --noEmit -->

## 2. Virtual-MCP 上下文解耦

- [x] 2.1 审查 `src/action/virtual-mcp.ts` 对 `brain/contextLoader` 的调用逻辑。
- [x] 2.2 将内部强依赖的读取动作剥离，调整为由参数或接口依赖注入（例如在执行时将上下文内容传入），从而移除顶部 `import { loadSkillContent } from '../brain/contextLoader.js'`。

<!-- checkpoint: npx vitest run test -->

## 3. 验收验证

- [x] 3.1 运行完整的类型检查和所有单元测试，确保无因为路径迁移导致的模块找不到错误。
- [x] 3.2 运行代码风格与规范检查。

<!-- checkpoint: npx eslint src && npx tsc --noEmit && npx vitest run test -->
