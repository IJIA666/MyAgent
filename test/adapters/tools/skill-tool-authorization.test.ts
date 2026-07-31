/**
 * @file skill_manage 权限适配器与统一网关测试。
 * 覆盖可信 origin、资源证据、delete 默认 ask、Plan/显式规则和后台 caller。
 */

import { isAbsolute, resolve } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SkillManageTool } from '../../../src/adapters/tools/impl/skill/skill-manage.js';
import { SkillManageAuthorizationAdapter } from '../../../src/adapters/tools/permissions/skill-tool-authorization.js';
import { ToolRegistry } from '../../../src/adapters/tools/toolRegistry.js';
import { SessionContext } from '../../../src/core/domain/context.js';
import { PermissionSessionState } from '../../../src/core/domain/permissions/permission-session-state.js';
import {
  createChildTrustedCallContext,
  createTrustedCallContext,
} from '../../../src/core/domain/permissions/trusted-call-context.js';
import { SkillLibrary } from '../../../src/core/usecases/brain/skill-library.js';
import { SkillUsageStore } from '../../../src/core/usecases/brain/skill-usage-store.js';
import {
  SKILL_REVIEW_CALLER_ID_PREFIX,
} from '../../../src/core/usecases/brain/skill-types.js';

describe('SkillManageAuthorizationAdapter', () => {
  let tempDir: string;
  let library: SkillLibrary;

  beforeEach(() => {
    tempDir = resolve(
      tmpdir(),
      `skill-auth-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const userSkills = resolve(tempDir, 'user');
    const projectSkills = resolve(tempDir, 'project');
    mkdirSync(userSkills, { recursive: true });
    mkdirSync(projectSkills, { recursive: true });
    library = new SkillLibrary(
      userSkills,
      projectSkills,
      resolve(userSkills, '.archive'),
      new SkillUsageStore(resolve(userSkills, '.usage.json')),
      { enableWatcher: false },
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('本地交互 caller 绑定 foreground，资源证据使用真实绝对用户路径', () => {
    const adapter = new SkillManageAuthorizationAdapter(library);
    const caller = createTrustedCallContext('local-user', 'interactive');
    const request = adapter.buildPermissionRequest({
      action: 'create',
      name: 'new-skill',
      content: skillContent('new-skill'),
      origin: 'background_review',
    }, {
      caller,
      toolResult: { kind: 'allow' },
    });

    expect(request.analysis).toEqual({
      kind: 'skill-manage',
      action: 'create',
      name: 'new-skill',
      origin: 'foreground',
      callerId: 'local-user',
    });
    const resource = request.resourceEvidences[0];
    expect(resource).toMatchObject({
      kind: 'directory-scope',
      operation: 'write',
      scope: 'external',
      channelTrust: 'interactive',
    });
    if (!resource || resource.kind !== 'directory-scope') {
      throw new Error('create 应生成 directory-scope 资源证据');
    }
    expect(isAbsolute(resource.canonicalPath)).toBe(true);
    expect(request.normalizedArgs).toHaveProperty('origin', 'background_review');
  });

  it('受信后台 Review caller 绑定 background_review，未知后台 caller 不生成分析', () => {
    const adapter = new SkillManageAuthorizationAdapter(library);
    const parent = createTrustedCallContext('parent', 'interactive');
    const reviewCaller = createChildTrustedCallContext(
      parent,
      `${SKILL_REVIEW_CALLER_ID_PREFIX}:run-1`,
    );
    const unknownCaller = createChildTrustedCallContext(parent, 'other-background-agent');

    expect(adapter.buildPermissionRequest({
      action: 'create',
      name: 'learned',
      content: skillContent('learned'),
    }, {
      caller: reviewCaller,
      toolResult: { kind: 'allow' },
    }).analysis).toMatchObject({ origin: 'background_review' });
    expect(adapter.buildPermissionRequest({
      action: 'create',
      name: 'unknown',
      content: skillContent('unknown'),
    }, {
      caller: unknownCaller,
      toolResult: { kind: 'allow' },
    }).analysis).toBeUndefined();
  });

  it('delete 始终是 ask 候选且不属于 ordinary edit', () => {
    const tool = new SkillManageTool(library);
    const adapter = tool.authorizationAdapter;
    const request = adapter.buildPermissionRequest({
      action: 'delete',
      name: 'target',
    }, {
      caller: createTrustedCallContext('local-user', 'interactive'),
      toolResult: tool.checkPermissions!({ action: 'delete', name: 'target' }),
    });

    expect(tool.checkPermissions!({ action: 'delete', name: 'target' })).toMatchObject({
      kind: 'ask',
      decisionCode: 'skill_manage_delete_requires_approval',
    });
    expect(request.isEditOperation).toBe(false);
    expect(adapter.isOrdinaryEdit(request)).toBe(false);
  });

  it('真实 ToolRegistry 注册 skill_manage，Plan 拒绝且 delete 批准后前台硬删除', async () => {
    const registry = new ToolRegistry(undefined, { skillLibrary: library });
    const session = new SessionContext('skill-gateway');
    const content = skillContent('gateway-skill');

    try {
      expect(registry.getTool('skill_manage')).toMatchObject({
        name: 'skill_manage',
        securityCategory: 'write',
      });

      session.setPermissionMode('plan');
      await expect(registry.callTool('skill_manage', {
        action: 'create',
        name: 'gateway-skill',
        content,
      }, session)).rejects.toThrow('plan 模式不允许');
      expect(library.get('gateway-skill')).toBeUndefined();

      session.setPermissionMode('default');
      const created = await registry.callTool('skill_manage', {
        action: 'create',
        name: 'gateway-skill',
        content,
      }, session);
      expect(parseToolJson(created.value)).toMatchObject({ status: 'success' });

      session.approvalInteraction.registerApprovalHandler((id) => {
        setTimeout(() => {
          session.approvalInteraction.resolve(id, { action: 'allowOnce' });
        }, 0);
      });
      const deleted = await registry.callTool('skill_manage', {
        action: 'delete',
        name: 'gateway-skill',
      }, session);
      expect(parseToolJson(deleted.value)).toMatchObject({
        status: 'success',
        action: 'delete',
      });
      expect(library.get('gateway-skill')).toBeUndefined();
    } finally {
      await registry.close();
    }
  });

  it('显式 deny 阻止执行，受信 background caller 的 origin 进入执行期', async () => {
    const registry = new ToolRegistry(undefined, { skillLibrary: library });
    const foregroundSession = new SessionContext('skill-deny');
    foregroundSession.getPermissionSessionState().getRuleStore().addRule('session', {
      source: 'session',
      ruleBehavior: 'deny',
      ruleValue: { toolName: 'skill_manage' },
    });

    try {
      await expect(registry.callTool('skill_manage', {
        action: 'create',
        name: 'denied-skill',
        content: skillContent('denied-skill'),
      }, foregroundSession)).rejects.toThrow('权限拒绝');
      expect(library.get('denied-skill')).toBeUndefined();

      const parent = createTrustedCallContext('parent', 'interactive');
      const caller = createChildTrustedCallContext(
        parent,
        `${SKILL_REVIEW_CALLER_ID_PREFIX}:run-2`,
      );
      const permissionState = new PermissionSessionState();
      const backgroundSession = new SessionContext('skill-background');
      const outcome = await registry.callTool(
        'skill_manage',
        {
          action: 'create',
          name: 'background-created',
          content: skillContent('background-created'),
        },
        backgroundSession,
        undefined,
        undefined,
        'background-create',
        30_000,
        {
          securityContext: {
            caller,
            permissionState,
            approvalAllowed: false,
            auditSource: 'skill_review_test',
          },
        },
      );
      expect(parseToolJson(outcome.value)).toMatchObject({
        status: 'success',
        agentCreated: true,
      });
    } finally {
      await registry.close();
    }
  });
});

/** 生成合法 Skill 正文。 */
function skillContent(name: string): string {
  return `---\nname: ${name}\ndescription: ${name} 描述\n---\n\n正文\n`;
}

/** 从 ToolRegistry 的 CallToolResult 中解析工具 JSON 包络。 */
function parseToolJson(value: unknown): Record<string, unknown> {
  const result = value as { content?: Array<{ text?: string }> };
  const text = result.content?.[0]?.text;
  if (!text) {
    throw new Error('工具结果缺少文本内容');
  }
  return JSON.parse(text) as Record<string, unknown>;
}
