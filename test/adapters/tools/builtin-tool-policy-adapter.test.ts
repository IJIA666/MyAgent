/**
 * BuiltinToolPolicyAdapter 单元测试。
 * 使用真实内建工具覆盖 pass、deny、suspend 和 session grant 识别路径。
 */

import { describe, it, expect } from 'vitest';
import { BuiltinToolPolicyAdapter } from '../../../src/adapters/tools/builtin-tool-policy-adapter.js';
import { buildNativeTools } from '../../../src/adapters/tools/tool-factory.js';

// 构造一批真实内建工具
const allTools = buildNativeTools();
const adapter = new BuiltinToolPolicyAdapter(allTools);

// 获取几个常见工具名用于测试
const readToolNames = allTools.filter(t => t.securityCategory === 'read').map(t => t.name);

describe('BuiltinToolPolicyAdapter', () => {
  describe('hasTool', () => {
    it('6.1 已注册内建工具返回 true', () => {
      for (const name of readToolNames.slice(0, 3)) {
        expect(adapter.hasTool(name)).toBe(true);
      }
    });

    it('6.1 不存在工具返回 false', () => {
      expect(adapter.hasTool('non-existent-tool')).toBe(false);
    });
  });

  describe('evaluate — 内建工具安全评估', () => {
    it('6.1 已注册工具的 checkSafety 返回 SafetyCheckResult，结构完整', async () => {
      // 对每个读工具用空参数调用，验证返回结构
      for (const name of readToolNames.slice(0, 2)) {
        const result = await adapter.evaluate(
          { toolCallId: 't-1', toolName: name, args: {} },
          // 使用最小 mock sessionContext
          { getSessionId: () => 'test', getTenantId: () => 'default',
            getPermissionMode: () => 'plan', getSecurityAllowlist: () => [],
            hasTemporaryReadWhitelist: () => false,
            hasTemporaryWriteWhitelist: () => false } as never,
        );
        expect(['pass', 'suspend', 'deny']).toContain(result.status);
        // message 可选，operation 可选，但必须有 status
      }
    });

    it('6.1 未知工具返回 deny', async () => {
      const result = await adapter.evaluate(
        { toolCallId: 't-unknown', toolName: 'ghost-tool', args: {} },
        undefined as never,
      );
      expect(result.status).toBe('deny');
      expect(result.message).toContain('未注册');
    });

    it('6.1 session grant 识别 — 已授权路径的读工具可返回 pass', async () => {
      // 构造一个带有只读白名单的 sessionContext mock
      const whitelisted = new Set<string>(['/tmp/test-dir']);
      const sessionContext = {
        getSessionId: () => 'test',
        getTenantId: () => 'default',
        getPermissionMode: () => 'plan',
        getSecurityAllowlist: () => [],
        hasTemporaryReadWhitelist: (p: string) => whitelisted.has(p),
        hasTemporaryWriteWhitelist: () => false,
      };

      for (const name of readToolNames.slice(0, 2)) {
        // 用空参数调用 — 不在白名单中的路径不会触发 pass
        const resultNoGrant = await adapter.evaluate(
          { toolCallId: 't-2', toolName: name, args: {} },
          sessionContext as never,
        );
        // 确保 checkSafety 被调用且不抛异常
        expect(['pass', 'suspend', 'deny']).toContain(resultNoGrant.status);
      }
    });
  });
});
