/**
 * @file 受保护资源策略测试。
 * 覆盖 managed deny 压制 project allow、环境变量拒绝、IDE 配置 ask。
 */

import { describe, it, expect } from 'vitest';
import { checkProtectedResource } from '../../../src/core/domain/permissions/protected-resource-policy.js';
import { ToolPermissionService } from '../../../src/core/domain/permissions/tool-permission-service.js';
import { PermissionSessionState } from '../../../src/core/domain/permissions/permission-session-state.js';
import { createTrustedCallContext } from '../../../src/core/domain/permissions/trusted-call-context.js';
import { writeFileAdapter } from '../../../src/adapters/tools/permissions/file-tool-authorization.js';
import { BROWSER_TOOL_AUTHORIZATION_ADAPTERS } from '../../../src/adapters/tools/permissions/browser-tool-authorization.js';
import { initWorkspace } from '../../../src/adapters/tools/impl/base.js';

describe('ProtectedResourcePolicy', () => {
  describe('.git/', () => {
    it('写入 .git/config 应 deny', () => {
      const result = checkProtectedResource('/workspace/.git/config', 'write');
      expect(result.decision).toBe('deny');
      expect(result.layer).toBe('managed');
    });

    it('读取 .git/HEAD 应通过', () => {
      const result = checkProtectedResource('/workspace/.git/HEAD', 'read');
      expect(result.decision).toBe('deny');
    });
  });

  describe('.myagent/', () => {
    it('写入 .myagent/settings.json 应 deny', () => {
      const result = checkProtectedResource('/workspace/.myagent/settings.json', 'write');
      expect(result.decision).toBe('deny');
    });

    it('写入 .myagent/settings.local.json 应 deny', () => {
      const result = checkProtectedResource('/workspace/.myagent/settings.local.json', 'write');
      expect(result.decision).toBe('deny');
    });

    it('写入 .myagent/rules/custom.json 应 deny', () => {
      const result = checkProtectedResource('/workspace/.myagent/rules/custom.json', 'write');
      expect(result.decision).toBe('deny');
    });
  });

  describe('.env', () => {
    it('写入 .env 应 deny', () => {
      const result = checkProtectedResource('/workspace/.env', 'write');
      expect(result.decision).toBe('deny');
    });

    it('写入 .env.production 应 deny', () => {
      const result = checkProtectedResource('/workspace/.env.production', 'write');
      expect(result.decision).toBe('deny');
    });
  });

  describe('IDE 配置', () => {
    it('写入 .husky/pre-commit 应 ask', () => {
      const result = checkProtectedResource('/workspace/.husky/pre-commit', 'write');
      expect(result.decision).toBe('ask');
    });

    it('写入 .vscode/settings.json 应 ask', () => {
      const result = checkProtectedResource('/workspace/.vscode/settings.json', 'write');
      expect(result.decision).toBe('ask');
    });

    it('读取 .vscode/settings.json 应 allow', () => {
      const result = checkProtectedResource('/workspace/.vscode/settings.json', 'read');
      expect(result.decision).toBe('allow');
    });
  });

  describe('普通路径', () => {
    it('普通工作区文件应不命中策略', () => {
      const result = checkProtectedResource('/workspace/src/index.ts', 'write');
      expect(result.decision).toBe('none');
    });
  });

  describe('统一 PermissionRequest 上限', () => {
    const caller = createTrustedCallContext('protected-resource-test', 'interactive');

    it('managed deny 应压制项目 allow 和 Accept edits on', async () => {
      initWorkspace(process.cwd());
      const state = new PermissionSessionState({ mode: 'acceptEdits' });
      state.getRuleStore().addRule('projectSettings', {
        source: 'projectSettings',
        ruleBehavior: 'allow',
        ruleValue: { toolName: 'writeFile', ruleContent: '*.git/config' },
      });
      const service = new ToolPermissionService({ ruleStore: state.getRuleStore() });
      const request = writeFileAdapter.buildPermissionRequest(
        { targetPath: '.git/config' },
        { caller },
      );

      const decision = await service.checkRequest(request, state, { caller });
      expect(decision).toMatchObject({
        kind: 'deny',
        decisionSource: 'invariant',
        overridable: false,
      });
    });

    it('浏览器 metadata 网络目标应在普通工具 allow 之前硬拒绝', async () => {
      const state = new PermissionSessionState({ mode: 'bypassPermissions' });
      const service = new ToolPermissionService({ ruleStore: state.getRuleStore() });
      const adapter = BROWSER_TOOL_AUTHORIZATION_ADAPTERS.get('browser_navigate')!;
      const request = adapter.buildPermissionRequest(
        { url: 'http://169.254.169.254/latest/meta-data' },
        { caller },
      );
      const decision = await service.checkRequest(request, state, {
        caller,
        toolResult: {
          kind: 'allow',
          decisionReason: '浏览器工具候选允许公开导航',
        },
      });

      expect(decision).toMatchObject({
        kind: 'deny',
        decisionSource: 'invariant',
        overridable: false,
      });
    });
  });
});
