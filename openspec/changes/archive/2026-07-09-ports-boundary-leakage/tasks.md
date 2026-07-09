## 1. 端口契约收口

- [x] 1.1 为 `AgentEvent`、`SafetyResource`、插件 hook 相关类型选定端口层拥有的位置，并新增对应类型文件
- [x] 1.2 新增端口层审批契约（命名与文件位置可按实现选择），用于替换 `ChatUseCase` 对 `ApprovalService` 的直接暴露
- [x] 1.3 更新 `src/ports/driving/ChatUseCase.ts`，使其只依赖端口层契约或纯数据结构，不再直接 import `src/core/` 类型
- [x] 1.4 更新 `src/ports/driven/tools/ToolAccessMetadataPort.ts` 与 `src/ports/driven/tools/AgentPlugin.ts`，使其只依赖端口层拥有的类型
- [x] 1.5 更新 core 中相关 import / re-export，使共享类型由端口层拥有，而不是由 ports 反向依赖 core
- [x] 1.6 让 `ApprovalService` 适配新的端口层审批契约，清理陈旧 import，完成编译验证

<!-- checkpoint: npm run build -->

## 2. 输入适配器依赖收敛

- [x] 2.1 盘点 `CliFacade` 对 `SessionManager` 的真实使用面，明确缺失的驱动端口能力
- [x] 2.2 在 `ChatUseCase` 或其配套契约中补齐这些最小能力，并由 `SessionManager` 适配实现
- [x] 2.3 修改 `src/adapters/input/interface/facade.ts`（CliFacade）：构造函数参数类型从 `SessionManager` 替换为 `ChatUseCase`，移除对核心实现类特有 API 的直接依赖
- [x] 2.4 更新 `CliFacade` 调用方与相关测试 / Mock，完成编译验证

<!-- checkpoint: npm run build -->

## 3. 整体验证

- [x] 3.1 确认 `src/ports/` 下所有接口再无对 `src/core/` 的直接 import
- [x] 3.2 确认 `CliFacade` 构造函数入参类型为 `ChatUseCase` 而非 `SessionManager`
- [x] 3.3 运行全量单测：`npm test`
- [x] 3.4 运行集成测试：`npm run test:integration`

<!-- checkpoint: npm run build -->
