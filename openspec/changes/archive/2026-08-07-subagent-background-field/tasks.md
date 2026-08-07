## 1. 定义解析启用

- [x] 1.1 `AgentDefinitionLoader`：`background` 从 DEFERRED_FIELDS 移除；解析为布尔（matter frontmatter 原生布尔）；非布尔值拒绝该定义并记录可诊断日志（fail-closed）
- [x] 1.2 `SubagentDefinition` 接口新增 `background?: boolean`

<!-- checkpoint: npm run build -->

## 2. 提交点强制与测试

- [x] 2.1 `SubagentCoordinator.submitRequest` 后台判定追加 `|| definition.background === true`（OR 语义对齐官方 AgentTool.tsx:567）
- [x] 2.2 加载器单测：background true/false/非法值（拒绝 + 日志）、移出 warning 清单
- [x] 2.3 协调器单测：background: true 定义强制后台（显式传 run_in_background: false 仍返回 async_launched）；未声明保持前台
- [x] 2.4 契约测试：configured-subagent-definitions 契约更新（生效字段清单 + 后台强制场景）
- [x] 2.5 全量门禁：lint + build + 单测（1263）+ 契约测试（133）+ 类型检查

<!-- checkpoint: npm run lint -->

<!-- checkpoint: npm test -->

<!-- checkpoint: npm run test:contract -->
