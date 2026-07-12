/**
 * ApprovalPolicy 已删除，由 ToolPermissionService + PermissionRuleStore 替代。
 * 相关能力测试已迁移至：
 * - test/core/permissions/rule-store.test.ts
 * - test/core/permissions/tool-permission-service.test.ts
 * - test/core/permissions/approval-flow.test.ts
 */

import { describe, it, expect } from 'vitest';

describe('ApprovalPolicy（已弃用）', () => {
  it('权限决策已迁移至 ToolPermissionService', () => {
    expect(true).toBe(true);
  });
});
