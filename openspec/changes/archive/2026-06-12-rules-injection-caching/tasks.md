## 1. 重构与扩展上下文适配器

- [x] 1.1 修改 `src/brain/adapters/ContextAdapter.ts` 接口，在 `assemble` 方法中支持传入可选的局部规则字段 `localRules?: string`。
- [x] 1.2 重构 `src/brain/adapters/DefaultContextAdapter.ts` 实现类，根据传入的局部规则文本构建 `role: 'system'` 消息，并包裹在 `<project_rules>` 与 `</project_rules>` 标签中。
- [x] 1.3 在 `DefaultContextAdapter` 中，将封装后的局部规则消息与临时技能消息一并安全插入至最新一条 `user` 消息之前。

<!-- checkpoint: npm run build -->

## 2. 引入规则内存锁定与加载逻辑

- [x] 2.1 修改 `src/brain/session.ts`，在 `SessionManager` 类中引入 `cachedGlobalRules` 与 `cachedLocalRules` 私有状态以充当内存缓存。
- [x] 2.2 实现局部规则文件（默认为 `.myagent.md` ）的自动探测读取方法，在会话初始化或首次启动时执行，并将内容缓存。
- [x] 2.3 重构 `SessionManager` 内的交互链路，在调用 `contextAdapter.assemble` 组装完整消息时，将缓存的局部规则参数传入。
- [x] 2.4 在 `SessionManager` 类中暴露 `reloadRules` 公共方法，允许清空内存中的规则缓存，从而在下一次 LLM 交互时强制重新读取磁盘文件。

<!-- checkpoint: npm run build -->

## 3. 业务功能集成与测试验证

- [x] 3.1 编写适配器单元测试，验证有无局部规则注入、有无 user 消息等边界场景下，重新组装的提示词历史顺序是否完全符合规格定义。
- [x] 3.2 运行代码规范检查（Linting）并执行全量构建，确保代码契约完全成立。

<!-- checkpoint: eslint . -->
