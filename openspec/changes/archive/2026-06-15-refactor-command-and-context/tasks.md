## 实施路径 (Execution Path)

- [x] 1. 创建子目录 `src/interface/commands/` 并定义 `ICommand` 核心接口文件 `base.ts`。
- [x] 2. 依次剥离现有的硬编码函数，为每个 Slash 命令（如 `model`, `mcp`, `help`, `history` 等）单独建立实现类/模块，并注入 `CommandContext` 依赖。
- [x] 3. 重写原有的 `src/interface/command.ts`，彻底剔除 `switch-case`，替换为自动装配或手动映射的命令注册表，完成请求的优雅分发。
- [x] 4. 抽取计算逻辑：建立 `src/brain/TokenEstimator.ts`。
- [x] 5. 为 `SessionContext` (`src/brain/context.ts`) 进行算法减负，将其转移给 `TokenEstimator` 处理。
- [x] 6. 连通性测试：重新运行全量测试用例并手动拉起 Agent，确保 `/help` 及其他交互指令的回显无任何倒退破坏。

<!-- checkpoint: npx vitest run test -q -->
