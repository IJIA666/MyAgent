## 1. 代码改造与分支拦截逻辑

- [x] 1.1 修改 `src/core/usecases/session.ts`，在 `SessionManager` 构造函数的末尾，增加对 `appConfig.runtimeLimits.ragEnabled` 配置状态的判定，仅在不为 `false` 时异步触发重建向量数据库 `rebuildVectorDbIfEmpty()`。
- [x] 1.2 修改 `src/core/usecases/LongTermMemoryPlugin.ts`，在 `handleSessionEndAsync` 提炼入口处，增加 `if (this.appConfig && this.appConfig.runtimeLimits.ragEnabled === false) return;` 拦截逻辑。

<!-- checkpoint: npm run build -->

## 2. 单元测试更新与回归验证

- [x] 2.1 修改或补充在 `test/brain/plugins.test.ts` 中的测试用例，提供在 `ragEnabled=false` 下 `SessionEnd` 被触发时拦截提炼回调执行的测试。
- [x] 2.2 执行全量单元测试与编译，确保修改后 187 项测试用例 100% 通过且静态检测 Lint 无报错。

<!-- checkpoint: npm run test -->
<!-- checkpoint: npm run lint -->
