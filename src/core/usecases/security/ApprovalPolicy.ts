/**
 * @fileoverview 中央审批策略服务（已弃用）。
 *
 * @deprecated 将在 10.x 删除。
 * 旧职责由 `ToolPermissionService` + `PermissionRuleStore` + 工具 `checkPermissions` 替代。
 * - `resolve()` → `ToolPermissionService.checkPermissions()` 产生 PermissionDecision
 * - `mapChoiceToEffect()` → `PermissionUpdate` 直接操作规则存储
 * - 资源提取器 → 工具 `checkPermissions` 内部处理
 * 当前保留为空壳，新代码不应再导入此模块。
 */
export {}
