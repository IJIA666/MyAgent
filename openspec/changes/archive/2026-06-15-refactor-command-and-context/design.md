# 架构设计: 解耦 Command Router 与胖 Context

## 1. 终端交互层改造 (Command Pattern)

我们将在 `src/interface/` 目录下建立统一的命令组织规范：

1. **抽象基类 `Command`**
   ```typescript
   export interface ICommand {
     name: string;
     description: string;
     execute(args: string[], context: CommandContext): Promise<CommandResult | void> | CommandResult | void;
   }
   ```
2. **命令工厂/注册中心 (`src/interface/command.ts`)**
   它将退化为一个轻量的调度器，通过映射字典 `Record<string, ICommand>` 来动态分发执行指令，不再硬编码具体的业务实现。
3. **隔离的策略实现类**
   所有的内置指令将被拆分为独立的文件，存放于 `src/interface/commands/` 目录中：
   - `ModelCommand` (`model.ts`)
   - `McpCommand` (`mcp.ts`)
   - `RollbackCommand` (`rollback.ts`)
   - `HistoryCommand` (`history.ts`)
   - `HelpCommand` (`help.ts`)
   - `CompactCommand` (`compact.ts`)
   - `ToolCommand` (`tool.ts`)
   - `SkillCommand` (`skill.ts`)

## 2. 大模型记忆层提纯 (Context Estimator)

`SessionContext` (位于 `src/brain/context.ts`) 是一个极其高频使用的模型，我们将其计算 Token 水位的繁重任务转移：

- **新建 `src/brain/TokenEstimator.ts`**：
  提供独立的无状态服务，专门负责将聊天历史数组转化为 Token 消耗预估数值。
- **改写 `SessionContext`**：
  剔除其内聚的 `estimateSnapshotTokens`、`getCompactionThreshold` 等依赖字符哈希与模型配置的粗重方法，让 `context.ts` 的行数大幅度缩减，专注于核心的数组操作与落盘序列化。
