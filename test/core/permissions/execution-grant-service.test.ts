/**
 * @file ExecutionGrantService 测试。
 * 覆盖签发、消费、重放防护和跨实例失效。
 */

import { describe, it, expect, vi } from 'vitest';
import { ExecutionPlan } from '../../../src/core/domain/permissions/execution-plan.js';
import { ExecutionGrantService } from '../../../src/core/domain/permissions/execution-grant-service.js';

describe('ExecutionGrantService', () => {
  it('签发 grant 后应可消费', () => {
    const svc = new ExecutionGrantService();
    const plan = new ExecutionPlan({
      runtimeToolName: 'writeFile',
      permissionIdentity: 'FileWrite',
      normalizedArgs: Object.freeze({ targetPath: '/test.ts' }),
      resourceEvidences: Object.freeze([]),
      evidenceDigest: 'abc123',
      callerId: 'test-caller',
      stateVersion: 1,
      hostPolicyVersion: '1.0.0',
      sandboxProfile: { platform: 'win32', containment: 'policy-only', version: '1.0' },
      expiryMs: 60000,
    });
    const grant = svc.issueGrant(plan);
    expect(grant.token).toBeTruthy();
    const result = svc.consumeGrant(grant, plan);
    expect(result.valid).toBe(true);
  });

  it('同一 grant 不能消费两次', () => {
    const svc = new ExecutionGrantService();
    const plan = new ExecutionPlan({
      runtimeToolName: 'readFile',
      permissionIdentity: 'FileRead',
      normalizedArgs: Object.freeze({ targetPath: '/test.ts' }),
      resourceEvidences: Object.freeze([]),
      evidenceDigest: 'abc123',
      callerId: 'test-caller',
      stateVersion: 1,
      hostPolicyVersion: '1.0.0',
      sandboxProfile: { platform: 'win32', containment: 'policy-only', version: '1.0' },
      expiryMs: 60000,
    });
    const grant = svc.issueGrant(plan);
    expect(svc.consumeGrant(grant, plan).valid).toBe(true);
    expect(svc.consumeGrant(grant, plan).valid).toBe(false);
  });

  it('stateVersion 不匹配应拒绝', () => {
    const svc = new ExecutionGrantService();
    const plan1 = new ExecutionPlan({
      runtimeToolName: 'writeFile', permissionIdentity: 'FileWrite',
      normalizedArgs: Object.freeze({}), resourceEvidences: Object.freeze([]),
      evidenceDigest: 'd1', callerId: 'c', stateVersion: 1,
      hostPolicyVersion: '1.0.0',
      sandboxProfile: { platform: 'win32', containment: 'policy-only', version: '1.0' },
      expiryMs: 60000,
    });
    const plan2 = new ExecutionPlan({
      runtimeToolName: 'writeFile', permissionIdentity: 'FileWrite',
      normalizedArgs: Object.freeze({}), resourceEvidences: Object.freeze([]),
      evidenceDigest: 'd1', callerId: 'c', stateVersion: 2,
      hostPolicyVersion: '1.0.0',
      sandboxProfile: { platform: 'win32', containment: 'policy-only', version: '1.0' },
      expiryMs: 60000,
    });
    const grant = svc.issueGrant(plan1);
    expect(svc.consumeGrant(grant, plan2).valid).toBe(false);
  });

  it('复制或伪造 grant 对象应被实例身份校验拒绝', () => {
    const svc = new ExecutionGrantService();
    const plan = new ExecutionPlan({
      runtimeToolName: 'writeFile', permissionIdentity: 'FileWrite',
      normalizedArgs: Object.freeze({}), resourceEvidences: Object.freeze([]),
      evidenceDigest: 'd1', callerId: 'c', stateVersion: 1,
      hostPolicyVersion: '1.0.0',
      sandboxProfile: { platform: 'win32', containment: 'policy-only', version: '1.0' },
      expiryMs: 60000,
    });
    const grant = svc.issueGrant(plan);
    const forged = Object.freeze({ ...grant });

    expect(svc.consumeGrant(forged, plan)).toMatchObject({
      valid: false,
      reason: 'grant 未由当前服务签发',
    });
    expect(svc.consumeGrant(grant, plan).valid).toBe(true);
  });

  it('其他服务实例不得消费 grant', () => {
    const issuer = new ExecutionGrantService();
    const other = new ExecutionGrantService();
    const plan = new ExecutionPlan({
      runtimeToolName: 'readFile', permissionIdentity: 'FileRead',
      normalizedArgs: Object.freeze({}), resourceEvidences: Object.freeze([]),
      evidenceDigest: 'd1', callerId: 'c', stateVersion: 1,
      hostPolicyVersion: '1.0.0',
      sandboxProfile: { platform: 'win32', containment: 'policy-only', version: '1.0' },
      expiryMs: 60000,
    });
    const grant = issuer.issueGrant(plan);
    expect(other.consumeGrant(grant, plan).valid).toBe(false);
  });

  it('原始嵌套参数在签发后变更不得篡改计划', () => {
    const svc = new ExecutionGrantService();
    const original = { nested: { command: 'safe' }, values: ['a'] };
    const plan = new ExecutionPlan({
      runtimeToolName: 'PowerShell', permissionIdentity: 'ShellPowerShell',
      normalizedArgs: original, resourceEvidences: Object.freeze([]),
      evidenceDigest: 'd1', callerId: 'c', stateVersion: 1,
      hostPolicyVersion: '1.0.0',
      sandboxProfile: { platform: 'win32', containment: 'policy-only', version: '1.0' },
      expiryMs: 60000,
    });
    const grant = svc.issueGrant(plan);
    original.nested.command = 'mutated';
    original.values.push('b');

    expect(plan.normalizedArgs).toEqual({
      nested: { command: 'safe' },
      values: ['a'],
    });
    expect(Object.isFrozen(plan.normalizedArgs)).toBe(true);
    expect(svc.consumeGrant(grant, plan).valid).toBe(true);
  });

  it('参数、资源、host policy 或 sandbox profile 漂移都应拒绝', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T00:00:00.000Z'));
    const svc = new ExecutionGrantService();
    const resource = {
      kind: 'file' as const,
      operation: 'write' as const,
      rawExpression: 'a.ts',
      canonicalPath: 'D:\\workspace\\a.ts',
      scope: 'workspace' as const,
      sourceNodeId: 'test:file',
      protected: false,
      provenance: 'host-verified' as const,
      channelTrust: 'interactive' as const,
    };
    const createPlan = (
      args: Record<string, unknown>,
      resourcePath: string,
      hostPolicyVersion = '1.0.0',
      sandboxVersion = '1.0',
    ): ExecutionPlan => new ExecutionPlan({
      runtimeToolName: 'writeFile',
      permissionIdentity: 'FileWrite',
      normalizedArgs: args,
      resourceEvidences: [{
        ...resource,
        canonicalPath: resourcePath,
      }],
      // 故意保持调用方摘要不变，验证服务直接绑定正式资源。
      evidenceDigest: 'same-caller-digest',
      callerId: 'c',
      stateVersion: 1,
      hostPolicyVersion,
      sandboxProfile: {
        platform: 'win32',
        containment: 'policy-only',
        version: sandboxVersion,
      },
      expiryMs: 60000,
    });

    try {
      for (const driftedPlan of [
        createPlan({ targetPath: 'b.ts' }, resource.canonicalPath),
        createPlan({ targetPath: 'a.ts' }, 'D:\\workspace\\b.ts'),
        createPlan({ targetPath: 'a.ts' }, resource.canonicalPath, '2.0.0'),
        createPlan({ targetPath: 'a.ts' }, resource.canonicalPath, '1.0.0', '2.0'),
      ]) {
        const originalPlan = createPlan({ targetPath: 'a.ts' }, resource.canonicalPath);
        const grant = svc.issueGrant(originalPlan);
        expect(svc.consumeGrant(grant, driftedPlan).valid).toBe(false);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('过期计划不得消费', () => {
    const svc = new ExecutionGrantService();
    const plan = new ExecutionPlan({
      runtimeToolName: 'readFile', permissionIdentity: 'FileRead',
      normalizedArgs: {}, resourceEvidences: [],
      evidenceDigest: 'expired', callerId: 'c', stateVersion: 1,
      hostPolicyVersion: '1.0.0',
      sandboxProfile: { platform: 'win32', containment: 'policy-only', version: '1.0' },
      expiryMs: -1,
    });
    const grant = svc.issueGrant(plan);
    expect(svc.consumeGrant(grant, plan)).toMatchObject({
      valid: false,
      reason: '执行计划已过期',
    });
  });

  it('credential profile 版本漂移应拒绝', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T00:00:00.000Z'));
    try {
      const svc = new ExecutionGrantService();
      const createPlan = (profileVersion: string): ExecutionPlan => new ExecutionPlan({
        runtimeToolName: 'mcp__demo',
        permissionIdentity: 'McpCall',
        normalizedArgs: {},
        resourceEvidences: [],
        evidenceDigest: 'mcp',
        callerId: 'c',
        stateVersion: 1,
        hostPolicyVersion: '1.0.0',
        sandboxProfile: {
          platform: 'win32',
          containment: 'policy-only',
          version: '1.0',
        },
        credentialProfile: {
          audience: 'mcp-server',
          version: profileVersion,
          inheritHostEnv: false,
        },
        expiryMs: 60_000,
      });
      const authorizedPlan = createPlan('1.0.0');
      const grant = svc.issueGrant(authorizedPlan);
      expect(svc.consumeGrant(grant, createPlan('2.0.0')).valid).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
