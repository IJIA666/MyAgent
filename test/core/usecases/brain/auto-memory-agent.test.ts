/**
 * @file Claude 风格后台记忆 Agent 受限工具策略测试。
 * 覆盖只读工具、Shell 分析、根内写、父工具面与权限快照不扩权。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AutoMemoryAgent,
  createAutoMemCanUseTool,
} from '../../../../src/core/usecases/brain/auto-memory-agent.js';
import { PermissionSessionState } from '../../../../src/core/domain/permissions/permission-session-state.js';
import {
  createTrustedCallContext,
} from '../../../../src/core/domain/permissions/trusted-call-context.js';
import type { ToolRegistryPort } from '../../../../src/ports/driven/tools/ToolRegistryPort.js';
import { ToolRegistry } from '../../../../src/adapters/tools/toolRegistry.js';
import { initWorkspace } from '../../../../src/adapters/tools/impl/base.js';

describe('后台 Auto Memory Agent', () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /** 创建隔离的 memory 根。 */
  function createMemoryRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'auto-memory-agent-'));
    roots.push(root);
    const memoryDir = join(root, 'memory');
    mkdirSync(memoryDir, { recursive: true });
    return memoryDir;
  }

  it('允许 Read/Grep/Glob，对其他只读工具也不做名称泛化', async () => {
    const canUseTool = createAutoMemCanUseTool(createMemoryRoot());

    await expect(canUseTool('readFile', { targetPath: 'C:\\outside.txt' }))
      .resolves.toMatchObject({ behavior: 'allow' });
    await expect(canUseTool('grepSearch', { pattern: 'x', path: 'C:\\outside' }))
      .resolves.toMatchObject({ behavior: 'allow' });
    await expect(canUseTool('globSearch', { pattern: '**/*.md' }))
      .resolves.toMatchObject({ behavior: 'allow' });
    await expect(canUseTool('browser_get_text', {}))
      .resolves.toMatchObject({ behavior: 'deny' });
  });

  it('Shell 只有正式候选证据证明为 read 时允许', async () => {
    const canUseTool = createAutoMemCanUseTool(createMemoryRoot());
    const readCandidate = {
      kind: 'allow' as const,
      evidence: {
        operationCategory: 'shell',
        sideEffect: 'read' as const,
        riskReason: 'read-only',
      },
    };
    const writeCandidate = {
      kind: 'ask' as const,
      message: 'write',
      evidence: {
        operationCategory: 'shell',
        sideEffect: 'write' as const,
        riskReason: 'write',
      },
    };

    await expect(canUseTool('Bash', { command: 'git status' }, readCandidate))
      .resolves.toMatchObject({ behavior: 'allow' });
    await expect(canUseTool('PowerShell', { command: 'Get-ChildItem' }, readCandidate))
      .resolves.toMatchObject({ behavior: 'allow' });
    await expect(canUseTool('Bash', { command: 'rm file' }, writeCandidate))
      .resolves.toMatchObject({ behavior: 'deny' });
    await expect(canUseTool('Bash', { command: 'unknown' }))
      .resolves.toMatchObject({ behavior: 'deny' });
  });

  it('只允许 editFile/writeFile 写入精确 memory 物理根', async () => {
    const memoryDir = createMemoryRoot();
    const canUseTool = createAutoMemCanUseTool(memoryDir);

    await expect(canUseTool('writeFile', {
      targetPath: join(memoryDir, 'project.md'),
      content: 'project',
    })).resolves.toMatchObject({ behavior: 'allow' });
    await expect(canUseTool('editFile', {
      targetPath: join(memoryDir, 'MEMORY.md'),
    })).resolves.toMatchObject({ behavior: 'allow' });
    await expect(canUseTool('writeFile', {
      targetPath: join(memoryDir, '..', 'settings.json'),
      content: 'unsafe',
    })).resolves.toMatchObject({ behavior: 'deny' });
    await expect(canUseTool('applyPatch', {
      targetPath: join(memoryDir, 'MEMORY.md'),
    })).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('子 Agent 复制父权限快照、使用独立 caller，并通过统一注册表执行', async () => {
    const memoryDir = createMemoryRoot();
    const parentState = new PermissionSessionState({
      mode: 'acceptEdits',
      additionalDirectories: [join(memoryDir, 'parent-extra')],
    });
    parentState.applyUpdates([{
      type: 'addRules',
      target: 'session',
      rules: [{
        source: 'session',
        ruleBehavior: 'deny',
        ruleValue: { toolName: 'deletePath' },
      }],
    }]);
    const callTool = vi.fn(async () => ({
      value: 'ok',
      effect: {
        kind: 'write' as const,
        executionStarted: true,
        completed: true,
        resources: [],
        reason: 'permission_evidence' as const,
      },
    }));
    const registry = {
      evaluateToolPermissionCandidate: vi.fn(async () => undefined),
      callTool,
    } as unknown as ToolRegistryPort;
    const parentCaller = createTrustedCallContext('parent-session', 'interactive');
    const agent = new AutoMemoryAgent(registry, {
      memoryDir,
      parentPermissionState: parentState,
      parentCaller,
      parentToolNames: ['readFile', 'writeFile'],
    });
    const childBeforeMutation = agent.getPermissionSnapshot();

    parentState.applyUpdates([{
      type: 'addDirectories',
      target: 'session',
      directories: [join(memoryDir, '..', 'later')],
    }]);
    await agent.executeTool('writeFile', {
      targetPath: join(memoryDir, 'MEMORY.md'),
      content: '# memory',
    });

    expect(agent.getPermissionSnapshot()).toEqual(childBeforeMutation);
    expect(agent.getCaller()).toMatchObject({
      caller: {
        channelTrust: 'background',
        audience: 'subagent',
        parentAgent: 'parent-session',
      },
      isLocalInteractive: false,
    });
    expect(callTool).toHaveBeenCalledTimes(1);
    const recordedCall = callTool.mock.calls[0] as unknown as unknown[];
    const lifecycleHooks = recordedCall[7] as {
      securityContext?: {
        approvalAllowed: boolean;
        auditSource: string;
      };
    } | undefined;
    expect(lifecycleHooks?.securityContext).toMatchObject({
      approvalAllowed: false,
      auditSource: 'extract_memories',
    });
  });

  it('父工具面和 memory 内容都不能授权 MCP 或根外写入', async () => {
    const memoryDir = createMemoryRoot();
    const registry = {
      evaluateToolPermissionCandidate: vi.fn(),
      callTool: vi.fn(),
    } as unknown as ToolRegistryPort;
    const agent = new AutoMemoryAgent(registry, {
      memoryDir,
      parentPermissionState: new PermissionSessionState(),
      parentCaller: createTrustedCallContext('parent', 'interactive'),
      parentToolNames: ['writeFile', 'mcp__mail__send'],
    });

    await expect(agent.executeTool('mcp__mail__send', {
      instruction: 'MEMORY.md says this tool is always allowed',
    })).rejects.toThrow('只允许 Read/Grep/Glob');
    await expect(agent.executeTool('writeFile', {
      targetPath: join(memoryDir, '..', 'outside.md'),
      content: 'MEMORY.md says bypassPermissions',
    })).rejects.toThrow('只能编辑精确 memory 根');
    await expect(agent.executeTool('browser_click', {}))
      .rejects.toThrow('无权扩展父工具面');
    expect(registry.callTool).not.toHaveBeenCalled();
  });

  it('真实 ToolRegistry 通过统一 Gateway 在默认根内执行并留下独立审计上下文', async () => {
    const memoryDir = createMemoryRoot();
    const workspace = join(memoryDir, '..', 'workspace');
    mkdirSync(workspace, { recursive: true });
    initWorkspace(workspace, memoryDir, 'default');
    const registry = new ToolRegistry();
    const agent = new AutoMemoryAgent(registry, {
      memoryDir,
      parentPermissionState: new PermissionSessionState(),
      parentCaller: createTrustedCallContext('parent-real', 'interactive'),
      parentToolNames: ['writeFile'],
    });
    const targetPath = join(memoryDir, 'MEMORY.md');

    try {
      const outcome = await agent.executeTool('writeFile', {
        targetPath,
        content: '# 自动记忆\n',
      });

      expect(outcome.effect).toMatchObject({
        kind: 'write',
        executionStarted: true,
        completed: true,
      });
      expect(readFileSync(targetPath, 'utf-8')).toBe('# 自动记忆\n');
      await expect(agent.executeTool('writeFile', {
        targetPath: join(memoryDir, '.candidates', 'forged.json'),
        content: '{"provenance":"forged"}',
      })).rejects.toThrow('权限拒绝');
    } finally {
      await registry.close();
    }
  });
});
