## 改造原因

目前 `src/config.ts` 承担了过多的职责（类型声明、常量存储、文件读写、环境变量插值等），已近 400 行，成为一个典型的“God Object”，违背了单一职责原则。如果不加干预，任何关于模型的添加、配置加载逻辑的调整都必须修改这个巨型文件，引发极大的冲突风险，降低了系统内聚度。拆分解耦势在必行，旨在为未来更多 MCP 工具与大模型配置接入奠定坚实的代码组织基础。

## 变更内容

- 引入门面模式 (Facade)，创建 `src/config/index.ts` 作为统一导出入口，确保对上游调用者零侵入。
- 提取纯接口定义至 `src/config/types.ts`。
- 将内置模型常量提取至 `src/config/models.ts`。
- 提取应用启动时的文件加载逻辑至 `src/config/loader.ts`。
- 将子进程安全的系统环境变量逻辑抽离至 `src/config/mcp-env.ts`。
- 将通用环境变量插值逻辑 (`interpolateEnvVars`, `requireEnv`) 下沉合并至 `src/utils/env.ts`。

## 业务能力

### 新增业务能力
- 无。本次为纯架构内聚性重构，不涉及新增业务链路。

### 修改业务能力
- 无。行为层面无修改，仅为内部代码组织结构的重构。

## 影响范围

- 物理文件移动与拆解，主文件 `src/config.ts` 将被解体。
- `src/index.ts`、`src/session.ts`、`src/mcp-client.ts`、`src/command.ts` 对原 `config.ts` 的引用路径将隐式迁移到 `src/config/index.ts`，由于采用门面模式，实际业务代码无实质性改动。
