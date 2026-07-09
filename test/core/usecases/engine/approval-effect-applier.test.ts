/**
 * @fileoverview ApprovalEffectApplier 的单元测试，验证审批效果提交（call/session grant 分流、持久化规则落盘、command-prefix 过滤）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ApprovalEffectApplier } from '../../../../src/core/usecases/engine/approval-effect-applier.js';
import { SessionContext } from '../../../../src/core/domain/context.js';
import { SecurityService } from '../../../../src/core/usecases/security/SecurityService.js';
import type { SafetyResource } from '../../../../src/core/usecases/security/SafetyResource.js';
import type { PendingGrant, PersistentRuleEffect } from '../../../../src/core/usecases/plugins/plugin-types.js';

/** 辅助函数：构造 SafetyResource */
function makeResource(overrides: Partial<SafetyResource> = {}): SafetyResource {
  return {
    kind: 'path',
    access: 'write',
    normalizedPath: '/test/path.txt',
    ...overrides
  } as SafetyResource;
}

describe('ApprovalEffectApplier', () => {
  let applier: ApprovalEffectApplier;
  let context: SessionContext;
  let tempDir: string;
  let configPath: string;

  beforeEach(() => {
    SecurityService.resetInstance();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-approval-test-'));
    configPath = path.join(tempDir, 'allowed_commands.json');

    applier = new ApprovalEffectApplier();
    context = new SessionContext('test-approval-session');
    // 确保 isProcessing 为 false，否则白名单写入会被拦截
    context.isProcessing = false;
  });

  afterEach(() => {
    SecurityService.resetInstance();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('applyPendingGrant - call 类型', () => {
    it('应注册 call capability 令牌并包含正确的 argumentsDigest', () => {
      const functionArgs = { filePath: '/test/foo.txt', content: 'hello' };
      const grant: PendingGrant = {
        type: 'call',
        toolCallId: 'call-001',
        toolName: 'writeFile',
        resources: [makeResource({ access: 'write', normalizedPath: '/test/foo.txt' })]
      };

      applier.applyPendingGrant(grant, context, functionArgs);

      // 验证 capability 已注册：claimCapability 成功时返回资源数组，失败时返回 null
      const claimed = context.claimCapability('call-001', 'writeFile', functionArgs);
      expect(claimed).not.toBeNull();
      expect(Array.isArray(claimed)).toBe(true);
    });

    it('应在缺少 functionArgs 时使用空对象计算 digest', () => {
      const grant: PendingGrant = {
        type: 'call',
        toolCallId: 'call-002',
        toolName: 'readFile',
        resources: [makeResource({ access: 'read' })]
      };

      // 不抛出异常即为通过
      expect(() => applier.applyPendingGrant(grant, context)).not.toThrow();

      // 空参数也能 claim：以空对象计算 digest
      const claimed = context.claimCapability('call-002', 'readFile', {});
      expect(claimed).not.toBeNull();
    });

    it('应在参数不匹配时 claim 失败', () => {
      const functionArgs = { filePath: '/test/bar.txt' };
      const grant: PendingGrant = {
        type: 'call',
        toolCallId: 'call-003',
        toolName: 'editFile',
        resources: [makeResource()]
      };

      applier.applyPendingGrant(grant, context, functionArgs);

      // 使用不同参数去 claim 应失败（返回 null）
      const claimed = context.claimCapability('call-003', 'editFile', { filePath: '/test/different.txt' });
      expect(claimed).toBeNull();
    });
  });

  describe('applyPendingGrant - session 类型', () => {
    it('应将读资源写入临时只读白名单', () => {
      const grant: PendingGrant = {
        type: 'session',
        toolCallId: 'call-010',
        resources: [
          makeResource({ kind: 'path', access: 'read', normalizedPath: '/test/readme.md' })
        ]
      };

      applier.applyPendingGrant(grant, context);

      // 通过 SecurityService 的 hasTemporaryReadWhitelist 验证
      const svc = SecurityService.getInstance(configPath);
      expect(svc.hasTemporaryReadWhitelist('test-approval-session', '/test/readme.md')).toBe(true);
    });

    it('应将写资源写入临时可写白名单', () => {
      const grant: PendingGrant = {
        type: 'session',
        toolCallId: 'call-011',
        resources: [
          makeResource({ kind: 'path', access: 'write', normalizedPath: '/test/output.txt' })
        ]
      };

      applier.applyPendingGrant(grant, context);

      const svc = SecurityService.getInstance(configPath);
      expect(svc.hasTemporaryWriteWhitelist('test-approval-session', '/test/output.txt')).toBe(true);
    });

    it('应将 directory-scope 资源写入目录范围只读白名单', () => {
      const grant: PendingGrant = {
        type: 'session',
        toolCallId: 'call-012',
        resources: [
          makeResource({ kind: 'directory-scope', access: 'read', normalizedPath: '/test/project' })
        ]
      };

      applier.applyPendingGrant(grant, context);

      const svc = SecurityService.getInstance(configPath);
      // 目录范围内子路径应命中
      expect(svc.hasTemporaryReadWhitelist('test-approval-session', '/test/project/src/index.ts')).toBe(true);
    });

    it('应跳过 command-prefix 类型资源不写入白名单', () => {
      const grant: PendingGrant = {
        type: 'session',
        toolCallId: 'call-013',
        resources: [
          { kind: 'command-prefix' as const, prefix: 'git' } as SafetyResource,
          makeResource({ kind: 'path', access: 'read', normalizedPath: '/test/valid.txt' })
        ]
      };

      applier.applyPendingGrant(grant, context);

      const svc = SecurityService.getInstance(configPath);
      // command-prefix 不应出现在 path 白名单中
      expect(svc.hasTemporaryReadWhitelist('test-approval-session', 'git')).toBe(false);
      // path 类型的正常资源应写入
      expect(svc.hasTemporaryReadWhitelist('test-approval-session', '/test/valid.txt')).toBe(true);
    });

    it('应同时处理多个混合类型资源', () => {
      const grant: PendingGrant = {
        type: 'session',
        toolCallId: 'call-014',
        resources: [
          makeResource({ kind: 'path', access: 'read', normalizedPath: '/test/a.txt' }),
          makeResource({ kind: 'path', access: 'write', normalizedPath: '/test/b.txt' }),
          makeResource({ kind: 'directory-scope', normalizedPath: '/test/lib' })
        ]
      };

      applier.applyPendingGrant(grant, context);

      const svc = SecurityService.getInstance(configPath);
      expect(svc.hasTemporaryReadWhitelist('test-approval-session', '/test/a.txt')).toBe(true);
      expect(svc.hasTemporaryWriteWhitelist('test-approval-session', '/test/b.txt')).toBe(true);
      expect(svc.hasTemporaryReadWhitelist('test-approval-session', '/test/lib/sub/file.txt')).toBe(true);
    });
  });

  describe('applyPersistentRuleEffect', () => {
    it('应将不存在的 prefix 规则持久化写入磁盘', () => {
      const effect: PersistentRuleEffect = {
        type: 'persistent',
        prefix: 'npm'
      };

      applier.applyPersistentRuleEffect(effect);

      const svc = SecurityService.getInstance(configPath);
      const whitelist = svc.getSecurityAllowlist();
      expect(whitelist).toContain('npm:*');
    });

    it('不应重复写入已存在的 prefix 规则', () => {
      // 先预写入
      SecurityService.getInstance(configPath).saveSecurityAllowlist(['npm:*']);

      const effect: PersistentRuleEffect = {
        type: 'persistent',
        prefix: 'npm'
      };

      applier.applyPersistentRuleEffect(effect);

      const svc = SecurityService.getInstance(configPath);
      const whitelist = svc.getSecurityAllowlist();
      // 应只出现一次
      expect(whitelist.filter(c => c === 'npm:*').length).toBe(1);
    });

    it('应能追加多个不同的 prefix', () => {
      SecurityService.getInstance(configPath).saveSecurityAllowlist(['npm:*']);

      applier.applyPersistentRuleEffect({ type: 'persistent', prefix: 'git' });
      applier.applyPersistentRuleEffect({ type: 'persistent', prefix: 'docker' });

      const svc = SecurityService.getInstance(configPath);
      const whitelist = svc.getSecurityAllowlist();
      expect(whitelist).toContain('npm:*');
      expect(whitelist).toContain('git:*');
      expect(whitelist).toContain('docker:*');
    });
  });
});
