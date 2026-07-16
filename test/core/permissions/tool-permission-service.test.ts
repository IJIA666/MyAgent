/**
 * @file ToolPermissionService 单元测试。
 * 覆盖工具拒绝、passthrough 转 ask、allow/ask/deny 冲突、dontAsk、acceptEdits 和 bypass 边界。
 */

import { describe, it, expect } from 'vitest';
import { PermissionRuleStore } from '../../../src/core/domain/permissions/rule-store.js';
import {
  ToolPermissionService,
} from '../../../src/core/domain/permissions/tool-permission-service.js';
import type {
  ToolPermissionCheckResult,
} from '../../../src/core/domain/permissions/permission-types.js';
import type {
  ToolExecutionContext,
} from '../../../src/core/domain/permissions/tool-permission-service.js';

describe('ToolPermissionService', () => {
  // ── 基础 passthrough → ask ──

  describe('passthrough → ask', () => {
    it('无规则和无工具检查时 passthrough 应转为 ask', async () => {
      const store = new PermissionRuleStore();
      const service = new ToolPermissionService({ ruleStore: store });

      const result = await service.checkPermissions('Bash', { command: 'ls' }, 'default');
      expect(result.kind).toBe('ask');
    });

    it('passthrough 不应产生 allow', async () => {
      const store = new PermissionRuleStore();
      const service = new ToolPermissionService({ ruleStore: store });

      const result = await service.checkPermissions('UnknownTool', {}, 'default');
      expect(result.kind).toBe('ask');
    });

    it('Shell 语法错误应按未知证据处理而不是成为不可绕过拒绝', async () => {
      const store = new PermissionRuleStore();
      const service = new ToolPermissionService({ ruleStore: store });
      const toolChecker = {
        checkPermissions(): ToolPermissionCheckResult {
          return {
            kind: 'passthrough',
            evidence: {
              operationCategory: 'command-execute',
              sideEffect: 'unknown',
              riskReason: '引号未闭合',
              parseStatus: 'invalid',
            },
          };
        },
      };

      const defaultResult = await service.checkPermissions(
        'Bash',
        { command: 'grep "unfinished' },
        'default',
        toolChecker,
      );
      const bypassResult = await service.checkPermissions(
        'Bash',
        { command: 'grep "unfinished' },
        'bypassPermissions',
        toolChecker,
      );

      expect(defaultResult).toMatchObject({ kind: 'ask', decisionSource: 'builtInBaseline' });
      expect(bypassResult).toMatchObject({ kind: 'allow', decisionSource: 'mode' });
    });
  });

  // ── 全局规则匹配 ──

  describe('全局规则', () => {
    it('全局 deny 规则应返回 deny', async () => {
      const store = new PermissionRuleStore();
      store.addRule('userSettings', {
        source: 'userSettings',
        ruleBehavior: 'deny',
        ruleValue: { toolName: 'Bash' },
      });
      const service = new ToolPermissionService({ ruleStore: store });

      const result = await service.checkPermissions('Bash', { command: 'rm -rf /' }, 'default');
      expect(result.kind).toBe('deny');
    });

    it('全局 ask 规则应返回 ask', async () => {
      const store = new PermissionRuleStore();
      store.addRule('userSettings', {
        source: 'userSettings',
        ruleBehavior: 'ask',
        ruleValue: { toolName: 'Bash' },
      });
      const service = new ToolPermissionService({ ruleStore: store });

      const result = await service.checkPermissions('Bash', { command: 'ls' }, 'default');
      expect(result.kind).toBe('ask');
    });

    it('全局 allow 规则应返回 allow', async () => {
      const store = new PermissionRuleStore();
      store.addRule('userSettings', {
        source: 'userSettings',
        ruleBehavior: 'allow',
        ruleValue: { toolName: 'Bash' },
      });
      const service = new ToolPermissionService({ ruleStore: store });

      const result = await service.checkPermissions('Bash', { command: 'ls' }, 'default');
      expect(result.kind).toBe('allow');
    });
  });

  // ── 工具 checkPermissions ──

  describe('工具 checkPermissions', () => {
    it('工具 deny 应终止流程', async () => {
      const store = new PermissionRuleStore();
      const service = new ToolPermissionService({ ruleStore: store });

      const toolChecker = {
        checkPermissions(_input: ToolExecutionContext): ToolPermissionCheckResult {
          return { kind: 'deny', decisionReason: '危险命令' };
        },
      };

      const result = await service.checkPermissions('Bash', { command: 'rm -rf /' }, 'default', toolChecker);
      expect(result.kind).toBe('deny');
      expect(result.decisionReason).toBe('危险命令');
    });

    it('工具 ask 应产生 ask', async () => {
      const store = new PermissionRuleStore();
      const service = new ToolPermissionService({ ruleStore: store });

      const toolChecker = {
        checkPermissions(_input: ToolExecutionContext): ToolPermissionCheckResult {
          return { kind: 'ask', message: '检查文件？', decisionReason: '敏感路径' };
        },
      };

      const result = await service.checkPermissions('Read', { path: '/etc/passwd' }, 'default', toolChecker);
      expect(result.kind).toBe('ask');
      expect((result as { kind: 'ask'; message: string }).message).toBe('检查文件？');
    });

    it('工具 allow 应放行', async () => {
      const store = new PermissionRuleStore();
      const service = new ToolPermissionService({ ruleStore: store });

      const toolChecker = {
        checkPermissions(_input: ToolExecutionContext): ToolPermissionCheckResult {
          return { kind: 'allow', decisionReason: '安全命令' };
        },
      };

      const result = await service.checkPermissions('Bash', { command: 'ls' }, 'default', toolChecker);
      expect(result.kind).toBe('allow');
    });

    it('工具 passthrough 应继续权限流程', async () => {
      const store = new PermissionRuleStore();
      const service = new ToolPermissionService({ ruleStore: store });

      const toolChecker = {
        checkPermissions(_input: ToolExecutionContext): ToolPermissionCheckResult {
          return { kind: 'passthrough' };
        },
      };

      const result = await service.checkPermissions('Bash', { command: 'ls' }, 'default', toolChecker);
      // passthrough + 无规则 → ask
      expect(result.kind).toBe('ask');
    });
  });

  // ── allow/ask/deny 冲突 ──

  describe('allow/ask/deny 冲突', () => {
    it('全局 deny 优先于工具 allow', async () => {
      const store = new PermissionRuleStore();
      store.addRule('userSettings', {
        source: 'userSettings',
        ruleBehavior: 'deny',
        ruleValue: { toolName: 'Bash' },
      });
      const service = new ToolPermissionService({ ruleStore: store });

      const toolChecker = {
        checkPermissions(_input: ToolExecutionContext): ToolPermissionCheckResult {
          return { kind: 'allow' };
        },
      };

      const result = await service.checkPermissions('Bash', { command: 'ls' }, 'default', toolChecker);
      // deny 规则在第一步就终止了
      expect(result.kind).toBe('deny');
    });

    it('工具 deny 优先于全局 allow', async () => {
      const store = new PermissionRuleStore();
      store.addRule('userSettings', {
        source: 'userSettings',
        ruleBehavior: 'allow',
        ruleValue: { toolName: 'Bash' },
      });
      const service = new ToolPermissionService({ ruleStore: store });

      const toolChecker = {
        checkPermissions(_input: ToolExecutionContext): ToolPermissionCheckResult {
          return { kind: 'deny', decisionReason: '工具级拒绝' };
        },
      };

      const result = await service.checkPermissions('Bash', { command: 'ls' }, 'default', toolChecker);
      expect(result.kind).toBe('deny');
    });

    it('显式 ask 不能跳过工具 deny，且工具检查只执行一次', async () => {
      const store = new PermissionRuleStore();
      store.addRule('userSettings', {
        source: 'userSettings',
        ruleBehavior: 'ask',
        ruleValue: { toolName: 'Bash' },
      });
      const service = new ToolPermissionService({ ruleStore: store });
      let checkCount = 0;
      const evidence = {
        operationCategory: 'command-execute',
        sideEffect: 'hardline' as const,
        riskReason: 'Git 写操作',
      };
      const toolChecker = {
        checkPermissions(_input: ToolExecutionContext): ToolPermissionCheckResult {
          checkCount += 1;
          return { kind: 'deny', decisionReason: '工具 hardline', evidence };
        },
      };

      const result = await service.checkPermissions(
        'Bash',
        { command: 'git commit -m blocked' },
        'default',
        toolChecker,
      );

      expect(result.kind).toBe('deny');
      expect(result.evidence).toBe(evidence);
      expect(checkCount).toBe(1);
    });

    it('未知命令的精确 allow 规则应覆盖普通工具 ask', async () => {
      const store = new PermissionRuleStore();
      store.addRule('session', {
        source: 'session',
        ruleBehavior: 'allow',
        ruleValue: { toolName: 'PowerShell', ruleContent: 'Invoke-CustomCheck' },
      });
      const service = new ToolPermissionService({ ruleStore: store });
      const evidence = {
        operationCategory: 'command-execute',
        sideEffect: 'unknown' as const,
        riskReason: '无法静态识别自定义命令',
      };
      const toolChecker = {
        checkPermissions(): ToolPermissionCheckResult {
          return { kind: 'ask', decisionReason: '工具无法判断', evidence };
        },
      };

      const result = await service.checkPermissions(
        'PowerShell',
        { command: 'Invoke-CustomCheck' },
        'default',
        toolChecker,
      );

      expect(result).toMatchObject({ kind: 'allow', decisionSource: 'userRule' });
    });

    it('只允许管道前半段时不得连带放行后半段写入', async () => {
      const store = new PermissionRuleStore();
      store.addRule('session', {
        source: 'session',
        ruleBehavior: 'allow',
        ruleValue: { toolName: 'Bash', ruleContent: 'cat a.txt' },
      });
      const service = new ToolPermissionService({ ruleStore: store });
      const evidence = {
        operationCategory: 'command-execute',
        sideEffect: 'write' as const,
        riskReason: '管道包含写入子命令',
        subcommands: [
          { command: 'cat a.txt', sideEffect: 'read' as const, permission: 'allow' as const, reason: '读取文件' },
          { command: 'rm output.txt', sideEffect: 'write' as const, permission: 'ask' as const, reason: '删除文件' },
        ],
      };
      const toolChecker = {
        checkPermissions(): ToolPermissionCheckResult {
          return { kind: 'passthrough', evidence };
        },
      };

      const result = await service.checkPermissions(
        'Bash',
        { command: 'cat a.txt | rm output.txt' },
        'default',
        toolChecker,
      );

      expect(result).toMatchObject({ kind: 'ask', decisionSource: 'builtInBaseline' });
    });

    it('资源命中显式 ask 时应覆盖命令的普通只读基线', async () => {
      const store = new PermissionRuleStore();
      store.addRule('userSettings', {
        source: 'userSettings',
        ruleBehavior: 'ask',
        ruleValue: { toolName: 'Bash', ruleContent: 'secret.txt' },
      });
      const service = new ToolPermissionService({ ruleStore: store });
      const evidence = {
        operationCategory: 'command-execute',
        sideEffect: 'read' as const,
        riskReason: '普通文件读取',
        subcommands: [
          { command: 'cat secret.txt', sideEffect: 'read' as const, permission: 'allow' as const, reason: '读取文件' },
        ],
        resources: [{
          kind: 'file' as const,
          operation: 'read' as const,
          rawExpression: 'secret.txt',
          resolvedResource: 'D:\\workspace\\secret.txt',
          baseContext: 'D:\\workspace',
          scope: 'workspace' as const,
          certainty: 'exact' as const,
          sourceNodeId: 'resource:secret',
          reason: '命令参数中的文件',
        }],
      };
      const toolChecker = {
        checkPermissions(): ToolPermissionCheckResult {
          return { kind: 'passthrough', evidence };
        },
      };

      const result = await service.checkPermissions(
        'Bash',
        { command: 'cat secret.txt' },
        'default',
        toolChecker,
      );

      expect(result).toMatchObject({
        kind: 'ask',
        decisionSource: 'userRule',
        matchedEvidenceIds: ['resource:secret'],
      });
    });
  });

  // ── dontAsk 模式 ──

  describe('dontAsk 模式', () => {
    it('dontAsk 应将 ask 转为 deny', async () => {
      const store = new PermissionRuleStore();
      const service = new ToolPermissionService({ ruleStore: store });

      const result = await service.checkPermissions('Bash', { command: 'ls' }, 'dontAsk');
      expect(result.kind).toBe('deny');
      expect(result.decisionReason).toContain('dontAsk');
    });

    it('dontAsk 不应阻止已预授权的 allow', async () => {
      const store = new PermissionRuleStore();
      store.addRule('userSettings', {
        source: 'userSettings',
        ruleBehavior: 'allow',
        ruleValue: { toolName: 'Bash' },
      });
      const service = new ToolPermissionService({ ruleStore: store });

      const result = await service.checkPermissions('Bash', { command: 'ls' }, 'dontAsk');
      expect(result.kind).toBe('allow');
    });
  });

  // ── acceptEdits 模式 ──

  describe('acceptEdits 模式', () => {
    it('acceptEdits 应对编辑操作自动 allow', async () => {
      const store = new PermissionRuleStore();
      const service = new ToolPermissionService({ ruleStore: store });

      const result = await service.checkPermissions('Write', { path: '/workspace/file.ts' }, 'acceptEdits');
      expect(result.kind).toBe('allow');
      expect(result.decisionReason).toContain('acceptEdits');
    });

    it('acceptEdits 不应自动允许终端命令', async () => {
      const store = new PermissionRuleStore();
      const service = new ToolPermissionService({ ruleStore: store });

      const result = await service.checkPermissions('Bash', { command: 'npm install' }, 'acceptEdits');
      // 未配置规则，终端命令仍为 ask
      expect(result.kind).toBe('ask');
    });
  });

  // ── plan 模式 ──

  describe('plan 模式', () => {
    it('plan 模式应拒绝写入操作', async () => {
      const store = new PermissionRuleStore();
      const service = new ToolPermissionService({ ruleStore: store });

      const result = await service.checkPermissions('Write', { path: '/workspace/file.ts' }, 'plan');
      expect(result.kind).toBe('deny');
      expect(result.decisionReason).toContain('plan');
    });

    it('plan 模式应直接允许已知只读工具', async () => {
      const store = new PermissionRuleStore();
      const service = new ToolPermissionService({ ruleStore: store });

      const result = await service.checkPermissions('Read', { path: '/workspace/file.ts' }, 'plan');
      expect(result.kind).toBe('allow');
    });
  });

  // ── bypassPermissions 模式 ──

  describe('bypassPermissions 模式', () => {
    it('bypass 应将 ask 转为 allow', async () => {
      const store = new PermissionRuleStore();
      const service = new ToolPermissionService({ ruleStore: store });

      const result = await service.checkPermissions('Bash', { command: 'ls' }, 'bypassPermissions');
      expect(result.kind).toBe('allow');
    });

    it('bypass 不应绕过显式 deny', async () => {
      const store = new PermissionRuleStore();
      store.addRule('userSettings', {
        source: 'userSettings',
        ruleBehavior: 'deny',
        ruleValue: { toolName: 'Bash' },
      });
      const service = new ToolPermissionService({ ruleStore: store });

      const result = await service.checkPermissions('Bash', { command: 'ls' }, 'bypassPermissions');
      expect(result.kind).toBe('deny');
    });

    it('bypass 不应绕过显式 ask，且不依赖原因文案', async () => {
      const store = new PermissionRuleStore();
      store.addRule('userSettings', {
        source: 'userSettings',
        ruleBehavior: 'ask',
        ruleValue: { toolName: 'Bash' },
      });
      const service = new ToolPermissionService({ ruleStore: store });

      const result = await service.checkPermissions('Bash', { command: 'ls' }, 'bypassPermissions');

      expect(result).toMatchObject({ kind: 'ask', decisionSource: 'userRule' });
      expect(result.decisionReason).not.toContain('显式 ask');
    });

    it('bypass 不应绕过工具 deny', async () => {
      const store = new PermissionRuleStore();
      const service = new ToolPermissionService({ ruleStore: store });

      const toolChecker = {
        checkPermissions(_input: ToolExecutionContext): ToolPermissionCheckResult {
          return { kind: 'deny', decisionReason: '工具拒绝' };
        },
      };

      const result = await service.checkPermissions('Bash', { command: 'danger' }, 'bypassPermissions', toolChecker);
      expect(result.kind).toBe('deny');
    });
  });

  // ── default 模式 ──

  describe('default 模式', () => {
    it('default 模式应保留 ask', async () => {
      const store = new PermissionRuleStore();
      const service = new ToolPermissionService({ ruleStore: store });

      const result = await service.checkPermissions('Bash', { command: 'ls' }, 'default');
      expect(result.kind).toBe('ask');
    });

    it('default 模式不改变 allow', async () => {
      const store = new PermissionRuleStore();
      store.addRule('userSettings', {
        source: 'userSettings',
        ruleBehavior: 'allow',
        ruleValue: { toolName: 'Bash' },
      });
      const service = new ToolPermissionService({ ruleStore: store });

      const result = await service.checkPermissions('Bash', { command: 'ls' }, 'default');
      expect(result.kind).toBe('allow');
    });
  });

  // ── AuthorizedContext ──

  describe('createAuthorizedContext', () => {
    it('allow 决策应生成授权上下文', () => {
      const store = new PermissionRuleStore();
      const service = new ToolPermissionService({ ruleStore: store });

      const ctx = service.createAuthorizedContext('Bash', { command: 'ls' }, {
        kind: 'allow',
        decisionReason: '已授权',
        decisionSource: 'userApproval',
        matchedEvidenceIds: [],
        overridable: false,
      });
      expect(ctx).not.toBeNull();
      expect(ctx!.toolName).toBe('Bash');
      expect(ctx!.nonce).toMatch(/^auth_/);
    });

    it('deny 决策不应生成授权上下文', () => {
      const store = new PermissionRuleStore();
      const service = new ToolPermissionService({ ruleStore: store });

      const ctx = service.createAuthorizedContext('Bash', { command: 'ls' }, {
        kind: 'deny',
        decisionReason: '拒绝',
        decisionSource: 'invariant',
        matchedEvidenceIds: [],
        overridable: false,
      });
      expect(ctx).toBeNull();
    });

    it('模式转换和授权上下文应保留同一份 evidence', async () => {
      const store = new PermissionRuleStore();
      const service = new ToolPermissionService({ ruleStore: store });
      const evidence = {
        operationCategory: 'command-execute',
        sideEffect: 'write' as const,
        riskReason: '写操作',
      };
      const toolChecker = {
        checkPermissions(): ToolPermissionCheckResult {
          return { kind: 'ask', message: '确认写入', decisionReason: '写操作', evidence };
        },
      };

      const decision = await service.checkPermissions('Bash', { command: 'touch a' }, 'bypassPermissions', toolChecker);
      expect(decision).toMatchObject({ kind: 'allow', evidence });

      const context = service.createAuthorizedContext('Bash', { command: 'touch a' }, decision);
      expect(context?.evidence).toBe(evidence);
    });
  });

  // ── headless + auto ──

  describe('headless 模式', () => {
    it('headless + auto + 无分类器应返回 deny', async () => {
      const store = new PermissionRuleStore();
      const service = new ToolPermissionService({ ruleStore: store, headless: true });

      const result = await service.checkPermissions('Bash', { command: 'ls' }, 'auto');
      expect(result.kind).toBe('deny');
    });
  });

  describe('auto 模式证据传递', () => {
    it('同一 PowerShell 工具应根据实际命令证据得到不同结果', async () => {
      const store = new PermissionRuleStore();
      let receivedSideEffect: string | undefined;
      const service = new ToolPermissionService({
        ruleStore: store,
        autoClassifier: {
          async classify(_toolName, _args, evidence) {
            receivedSideEffect = evidence?.sideEffect;
            return { allow: false, reason: '写入证据不允许自动执行' };
          },
        },
      });
      const readChecker = {
        checkPermissions(): ToolPermissionCheckResult {
          return {
            kind: 'passthrough',
            evidence: {
              operationCategory: 'command-execute',
              sideEffect: 'read',
              riskReason: '读取 package.json',
            },
          };
        },
      };
      const writeChecker = {
        checkPermissions(): ToolPermissionCheckResult {
          return {
            kind: 'passthrough',
            evidence: {
              operationCategory: 'command-execute',
              sideEffect: 'write',
              riskReason: '写入 output.txt',
            },
          };
        },
      };

      const readResult = await service.checkPermissions(
        'PowerShell',
        { command: 'Get-Content package.json' },
        'auto',
        readChecker,
      );
      const writeResult = await service.checkPermissions(
        'PowerShell',
        { command: 'Set-Content output.txt done' },
        'auto',
        writeChecker,
      );

      expect(readResult).toMatchObject({ kind: 'allow', decisionSource: 'builtInBaseline' });
      expect(writeResult).toMatchObject({ kind: 'deny', decisionSource: 'classifier' });
      expect(receivedSideEffect).toBe('write');
    });
  });
});
