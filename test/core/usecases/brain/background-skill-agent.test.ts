/**
 * @file BackgroundSkillAgent 的固定工具面、权限快照和 ToolGateway 调用测试。
 */

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { BackgroundSkillAgent } from '../../../../src/core/usecases/brain/background-skill-agent.js';
import { PermissionSessionState } from '../../../../src/core/domain/permissions/permission-session-state.js';
import { createTrustedCallContext } from '../../../../src/core/domain/permissions/trusted-call-context.js';
import { SkillReviewReadLedger } from '../../../../src/core/usecases/brain/skill-review-read-ledger.js';
import type { ToolRegistryPort } from '../../../../src/ports/driven/tools/ToolRegistryPort.js';

/** 创建包含本地、交互和 MCP 风格定义的父工具注册表。 */
function createParentRegistry() {
  return {
    getTools: vi.fn().mockResolvedValue([
      { type: 'function', function: { name: 'load_skill' } },
      { type: 'function', function: { name: 'skill_manage' } },
      { type: 'function', function: { name: 'readFile' } },
      { type: 'function', function: { name: 'BrowserNavigate' } },
      { type: 'function', function: { name: 'server_remote_tool' } },
      { type: 'function', function: { name: 'ask_user_question' } },
    ]),
    getTool: vi.fn((name: string) => ({
      name,
      securityCategory: name === 'skill_manage' ? 'write' as const : 'read' as const,
    })),
    callTool: vi.fn().mockResolvedValue({
      value: { content: [{ type: 'text', text: '{"status":"success","action":"patch","name":"demo","summary":"ok"}' }] },
      effect: {
        kind: 'write',
        executionStarted: true,
        completed: true,
        resources: [],
        reason: 'permission_evidence',
      },
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('BackgroundSkillAgent', () => {
  it('只暴露父工具集合与 load_skill/skill_manage 的交集', async () => {
    const parent = createParentRegistry();
    const agent = new BackgroundSkillAgent(parent as unknown as ToolRegistryPort, {
      parentPermissionState: new PermissionSessionState(),
      parentCaller: createTrustedCallContext('parent-session'),
      parentToolNames: ['load_skill', 'skill_manage', 'readFile', 'BrowserNavigate', 'server_remote_tool'],
      callerId: 'background-skill-review:test',
    });

    const tools = await agent.getTools() as Array<{ function: { name: string } }>;
    expect(tools.map(tool => tool.function.name)).toEqual(['load_skill', 'skill_manage']);
    expect(agent.getTool('readFile')).toBeUndefined();
    expect(agent.getTool('skill_manage')).toMatchObject({ securityCategory: 'write' });
  });

  it.each([
    'Memory',
    'readFile',
    'PowerShell',
    'BrowserNavigate',
    'server_remote_tool',
    'ask_user_question',
    'unknown_tool',
  ])('拒绝固定工具面之外的 %s', async toolName => {
    const parent = createParentRegistry();
    const agent = new BackgroundSkillAgent(parent as unknown as ToolRegistryPort, {
      parentPermissionState: new PermissionSessionState(),
      parentCaller: createTrustedCallContext('parent-session'),
      parentToolNames: [
        'load_skill',
        'skill_manage',
        'readFile',
        'PowerShell',
        'BrowserNavigate',
        'server_remote_tool',
        'ask_user_question',
      ],
      callerId: 'background-skill-review:test',
    });

    await expect(agent.callTool(toolName, {})).rejects.toThrow('不允许调用工具');
    expect(parent.callTool).not.toHaveBeenCalled();
  });

  it('复制父权限状态并用 background/subagent caller 禁用审批', async () => {
    const parent = createParentRegistry();
    const parentPermissionState = new PermissionSessionState({
      mode: 'acceptEdits',
      additionalDirectories: ['D:\\allowed'],
    });
    const mutationSpy = vi.fn();
    const agent = new BackgroundSkillAgent(parent as unknown as ToolRegistryPort, {
      parentPermissionState,
      parentCaller: createTrustedCallContext('parent-session'),
      parentToolNames: ['load_skill', 'skill_manage'],
      callerId: 'background-skill-review:test',
      onSkillMutation: mutationSpy,
    });
    parentPermissionState.applyUpdates([{
      type: 'setMode',
      target: 'session',
      mode: 'plan',
    }]);

    expect(agent.getPermissionSnapshot().mode).toBe('acceptEdits');
    expect(agent.getCaller()).toMatchObject({
      caller: {
        channelTrust: 'background',
        audience: 'subagent',
        callerId: 'background-skill-review:test',
      },
      hostVerified: true,
      isLocalInteractive: false,
    });

    await agent.callTool('skill_manage', {
      action: 'patch',
      name: 'demo',
      oldString: 'a',
      newString: 'b',
    });

    const lifecycle = parent.callTool.mock.calls[0][7];
    expect(lifecycle.securityContext).toMatchObject({
      approvalAllowed: false,
      auditSource: 'background_skill_review',
    });
    expect(lifecycle.securityContext.permissionState).not.toBe(parentPermissionState);
    expect(mutationSpy).toHaveBeenCalledWith({
      status: 'success',
      action: 'patch',
      name: 'demo',
    });
  });

  it('load_skill 真实成功后记录读取凭证，失败或取消不记账', async () => {
    const ledger = new SkillReviewReadLedger('background-skill-review:test');
    const parent = createParentRegistry();
    // 第一次调用：load_skill 成功，返回主文件正文。
    parent.callTool.mockResolvedValueOnce({
      value: { content: [{ type: 'text', text: '支持文件正文' }] },
      effect: {
        kind: 'read',
        executionStarted: true,
        completed: true,
        resources: [],
        reason: 'declared_read_tool',
      },
    });
    const agent = new BackgroundSkillAgent(parent as unknown as ToolRegistryPort, {
      parentPermissionState: new PermissionSessionState(),
      parentCaller: createTrustedCallContext('parent-session'),
      parentToolNames: ['load_skill', 'skill_manage'],
      callerId: 'background-skill-review:test',
      readLedger: ledger,
    });

    await agent.callTool('load_skill', { name: 'demo', file_path: 'references/a.md' });
    expect(ledger.getRecord('demo', 'references/a.md')).toBeDefined();
    const precondition = ledger.buildPrecondition(
      'background-skill-review:test',
      'patch',
      'demo',
      'references/a.md',
    );
    expect(Object.values(precondition?.requiredReads ?? {})).toEqual([
      createHash('sha256').update('支持文件正文').digest('hex'),
    ]);

    // 第二次调用：load_skill 失败（携带 cause），不得产生读取凭证。
    parent.callTool.mockResolvedValueOnce({
      value: { content: [{ type: 'text', text: '错误' }] },
      effect: {
        kind: 'read',
        executionStarted: true,
        completed: true,
        resources: [],
        reason: 'declared_read_tool',
      },
      cause: new Error('load failed'),
    });
    await agent.callTool('load_skill', { name: 'other' });
    expect(ledger.getRecord('other', null)).toBeUndefined();
  });

  it('模型输出会被折叠时不为完整正文签发读取凭证', async () => {
    const ledger = new SkillReviewReadLedger('background-skill-review:test');
    const parent = createParentRegistry();
    parent.callTool.mockResolvedValueOnce({
      value: { content: [{ type: 'text', text: 'x'.repeat(60 * 1024) }] },
      effect: {
        kind: 'read',
        executionStarted: true,
        completed: true,
        resources: [],
        reason: 'declared_read_tool',
      },
    });
    const agent = new BackgroundSkillAgent(parent as unknown as ToolRegistryPort, {
      parentPermissionState: new PermissionSessionState(),
      parentCaller: createTrustedCallContext('parent-session'),
      parentToolNames: ['load_skill', 'skill_manage'],
      callerId: 'background-skill-review:test',
      readLedger: ledger,
    });

    await agent.callTool('load_skill', { name: 'oversized' });

    expect(ledger.getRecord('oversized', null)).toBeUndefined();
    expect(ledger.buildPrecondition(
      'background-skill-review:test',
      'edit',
      'oversized',
    )).toBeNull();
  });

  it('关闭检查失败时不得进入父 ToolGateway', async () => {
    const parent = createParentRegistry();
    const agent = new BackgroundSkillAgent(parent as unknown as ToolRegistryPort, {
      parentPermissionState: new PermissionSessionState(),
      parentCaller: createTrustedCallContext('parent-session'),
      parentToolNames: ['load_skill', 'skill_manage'],
      callerId: 'background-skill-review:test',
      isActive: () => false,
    });

    await expect(agent.callTool('load_skill', { name: 'demo' })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(parent.callTool).not.toHaveBeenCalled();
  });
});
