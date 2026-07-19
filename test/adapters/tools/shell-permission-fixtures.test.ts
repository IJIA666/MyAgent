/**
 * @file Shell 权限行为夹具驱动测试。
 * 通过真实 Bash/PowerShell 工具入口验证候选决定、规则建议和 analysis 契约。
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { PermissionRuleStore } from '../../../src/core/domain/permissions/rule-store.js';
import { BashTool, PowerShellTool } from '../../../src/adapters/tools/impl/system/terminal.js';
import { initWorkspace } from '../../../src/adapters/tools/impl/base.js';
import { SHELL_PERMISSION_FIXTURES } from '../../fixtures/shell-permissions/cases.js';

describe('Shell 权限行为夹具', () => {
  beforeAll(() => {
    initWorkspace(process.cwd());
  });

  for (const fixture of SHELL_PERMISSION_FIXTURES) {
    const platformSupported = fixture.toolName === 'Bash' || process.platform === 'win32';
    it.runIf(platformSupported)(fixture.name, async () => {
      const tool = fixture.toolName === 'Bash' ? new BashTool() : new PowerShellTool();
      const result = await tool.checkPermissions(
        { command: fixture.command },
        { mode: 'default', rules: new PermissionRuleStore() },
      );

      expect(result.kind).toBe(fixture.expectedKind);
      expect(result.analysis).toBeDefined();
      expect(result.decisionCode).toMatch(/^shell\./);
      expect((result.ruleSuggestions?.length ?? 0) > 0)
        .toBe(fixture.expectsRuleSuggestion);
    });
  }
});
