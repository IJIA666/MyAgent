## 改造原因

经过近期的探索与架构依赖扫描，我们发现当前系统的核心模块存在两处违背单向依赖树原则的“反向耦合”（代码坏味道）：
1. **底层的 UI 依赖**：`config/loader.ts` 作为底层配置加载设施，为了彩色输出，反向引用了表示层的 `interface/theme.ts`。
2. **行动层的越权**：`action/virtual-mcp.ts` 作为工具层，直接硬编码引用了大脑层的 `brain/contextLoader.ts` 逻辑。
为了保持架构的长期健康，防范未来服务拆分或 MCP 化时的网状依赖陷阱，我们需要及早执行解耦。

## 变更内容

本次采用探索报告中推荐的“方案 A（局部重构/解耦）”：
1. 将 `theme.ts` 的纯函数颜色控制逻辑从 `interface` 层剥离，下沉为基础设施层工具（如 `utils/logger.ts` 或类似模块）。
2. 将 `virtual-mcp.ts` 中对 `brain/contextLoader.ts` 的直接依赖切断，改由其调用方通过接口依赖注入或将相关加载职责移交大脑层本身处理。

## 业务能力

### 新增业务能力
无（纯技术底层重构）

### 修改业务能力
无（不涉及任何外部业务契约变化）

## 影响范围

- `src/config/loader.ts` 及其引用的日志体系
- `src/interface/theme.ts` 及所有调用到 theme 的命令类（大量 Import 路径变动）
- `src/action/virtual-mcp.ts` 及其注册链
