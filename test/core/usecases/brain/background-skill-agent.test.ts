/**
 * @file BackgroundSkillAgent 的固定工具面、权限快照和 ToolGateway 调用测试。
 */

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { BackgroundSkillAgent } from '../../../../src/core/usecases/brain/background-skill-agent.js';
import { PermissionSessionState } from '../../../../src/core/domain/permissions/permission-session-state.js';
import { createTrustedCallContext } from '../../../../src/core/domain/permissions/trusted-call-context.js';
import { SkillReviewReadLedger } from '../../../../src/core/usecases/brain/skill-review-read-ledger.js';
import { SKILL_CURATOR_CALLER_ID_PREFIX } from '../../../../src/core/usecases/brain/skill-types.js';
import { serializeToolOutcomeForModel } from '../../../../src/core/usecases/engine/ToolDispatcher.js';
import type { ToolRegistryPort } from '../../../../src/ports/driven/tools/ToolRegistryPort.js';

/** 创建包含本地、交互和 MCP 风格定义的父工具注册表。 */
function createParentRegistry() {
  return {
    getTools: vi.fn().mockResolvedValue([
      { type: 'function', function: { name: 'skills_list' } },
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
  it('只暴露父工具集合与 skills_list/load_skill/skill_manage 的交集', async () => {
    const parent = createParentRegistry();
    const agent = new BackgroundSkillAgent(parent as unknown as ToolRegistryPort, {
      parentPermissionState: new PermissionSessionState(),
      parentCaller: createTrustedCallContext('parent-session'),
      parentToolNames: ['skills_list', 'load_skill', 'skill_manage', 'readFile', 'BrowserNavigate', 'server_remote_tool'],
      callerId: 'background-skill-review:test',
    });

    const tools = await agent.getTools() as Array<{ function: { name: string } }>;
    expect(tools.map(tool => tool.function.name)).toEqual(['skills_list', 'load_skill', 'skill_manage']);
    expect(agent.getTool('readFile')).toBeUndefined();
    expect(agent.getTool('skills_list')).toMatchObject({ securityCategory: 'read' });
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

  it('load_skill 结构化结果真实成功后仅以 content 记账，失败或取消不记账', async () => {
    const ledger = new SkillReviewReadLedger('background-skill-review:test');
    const parent = createParentRegistry();
    // 第一次调用：load_skill 成功，返回结构化 JSON 包络（支持文件）。
    parent.callTool.mockResolvedValueOnce({
      value: { content: [{ type: 'text', text: JSON.stringify({
        name: 'demo',
        description: '示例',
        source: 'user',
        file: 'references/a.md',
        content: '支持文件正文',
        supportFiles: [],
      }) }] },
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
      parentToolNames: ['skills_list', 'load_skill', 'skill_manage'],
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
    // 摘要只来自包络中的 content 原文，而不是整个 JSON。
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

  it('skills_list 目录调用只透传且绝不写入读取账本', async () => {
    const ledger = new SkillReviewReadLedger('background-skill-review:test');
    const parent = createParentRegistry();
    parent.callTool.mockResolvedValueOnce({
      value: { content: [{ type: 'text', text: JSON.stringify({
        skills: [{ name: 'demo', description: '示例', source: 'user' }],
        totalCount: 1,
        matchedCount: 1,
        returnedCount: 1,
        complete: true,
      }) }] },
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
      parentToolNames: ['skills_list', 'load_skill', 'skill_manage'],
      callerId: 'background-skill-review:test',
      readLedger: ledger,
    });

    const outcome = await agent.callTool('skills_list', { category: 'development' });
    // 目录结果原样透传给模型。
    expect(JSON.parse((outcome.value as { content: Array<{ text: string }> }).content[0].text))
      .toMatchObject({ totalCount: 1, complete: true });
    // 目录浏览不构成看过准确目标的证据：任何 Skill 都不产生读取凭证。
    expect(ledger.getRecord('demo', null)).toBeUndefined();
    expect(ledger.buildPrecondition(
      'background-skill-review:test',
      'patch',
      'demo',
    )).toBeNull();
  });

  it('Curator 在进入父 ToolGateway 前拒绝修改本轮候选范围外的既有 Skill', async () => {
    const parent = createParentRegistry();
    const agent = new BackgroundSkillAgent(parent as unknown as ToolRegistryPort, {
      parentPermissionState: new PermissionSessionState(),
      parentCaller: createTrustedCallContext('parent-session'),
      parentToolNames: ['skills_list', 'load_skill', 'skill_manage'],
      callerId: 'background-skill-curator:test',
      callerIdPrefix: SKILL_CURATOR_CALLER_ID_PREFIX,
      allowedExistingSkillNames: ['candidate-skill'],
    });

    await expect(agent.callTool('skill_manage', {
      action: 'patch',
      name: 'late-arriving-skill',
      oldString: 'a',
      newString: 'b',
    })).rejects.toThrow('Curator 本轮候选范围不允许修改 Skill');
    expect(parent.callTool).not.toHaveBeenCalled();

    await agent.callTool('skill_manage', {
      action: 'patch',
      name: 'candidate-skill',
      oldString: 'a',
      newString: 'b',
    });
    expect(parent.callTool).toHaveBeenCalledTimes(1);
  });

  it('Curator 成功创建的新 umbrella 可在同一任务中继续维护', async () => {
    const parent = createParentRegistry();
    parent.callTool
      .mockResolvedValueOnce({
        value: { content: [{ type: 'text', text: '{"status":"success","action":"create","name":"new-umbrella","summary":"ok"}' }] },
        effect: {
          kind: 'write',
          executionStarted: true,
          completed: true,
          resources: [],
          reason: 'permission_evidence',
        },
      })
      .mockResolvedValueOnce({
        value: { content: [{ type: 'text', text: '{"status":"success","action":"patch","name":"new-umbrella","summary":"ok"}' }] },
        effect: {
          kind: 'write',
          executionStarted: true,
          completed: true,
          resources: [],
          reason: 'permission_evidence',
        },
      });
    const agent = new BackgroundSkillAgent(parent as unknown as ToolRegistryPort, {
      parentPermissionState: new PermissionSessionState(),
      parentCaller: createTrustedCallContext('parent-session'),
      parentToolNames: ['skills_list', 'load_skill', 'skill_manage'],
      callerId: 'background-skill-curator:test',
      callerIdPrefix: SKILL_CURATOR_CALLER_ID_PREFIX,
      allowedExistingSkillNames: [],
    });

    await agent.callTool('skill_manage', {
      action: 'create',
      name: 'new-umbrella',
      content: 'new content',
    });
    await expect(agent.callTool('skill_manage', {
      action: 'patch',
      name: 'new-umbrella',
      oldString: 'new',
      newString: 'updated',
    })).resolves.toBeDefined();
    expect(parent.callTool).toHaveBeenCalledTimes(2);
  });

  it('旧纯字符串、字段错配与非法 JSON 结果均不签发读取凭证', async () => {
    const ledger = new SkillReviewReadLedger('background-skill-review:test');
    const parent = createParentRegistry();
    const agent = new BackgroundSkillAgent(parent as unknown as ToolRegistryPort, {
      parentPermissionState: new PermissionSessionState(),
      parentCaller: createTrustedCallContext('parent-session'),
      parentToolNames: ['skills_list', 'load_skill', 'skill_manage'],
      callerId: 'background-skill-review:test',
      readLedger: ledger,
    });

    // 旧纯字符串正文：不是合法 JSON，fail-closed。
    parent.callTool.mockResolvedValueOnce({
      value: { content: [{ type: 'text', text: '直接正文而非 JSON' }] },
      effect: {
        kind: 'read',
        executionStarted: true,
        completed: true,
        resources: [],
        reason: 'declared_read_tool',
      },
    });
    await agent.callTool('load_skill', { name: 'legacy' });
    expect(ledger.getRecord('legacy', null)).toBeUndefined();

    // name 与调用参数错配。
    parent.callTool.mockResolvedValueOnce({
      value: { content: [{ type: 'text', text: JSON.stringify({
        name: 'other-skill',
        description: '示例',
        source: 'user',
        file: 'SKILL.md',
        content: '正文',
        supportFiles: [],
      }) }] },
      effect: {
        kind: 'read',
        executionStarted: true,
        completed: true,
        resources: [],
        reason: 'declared_read_tool',
      },
    });
    await agent.callTool('load_skill', { name: 'requested-name' });
    expect(ledger.getRecord('requested-name', null)).toBeUndefined();

    // file 与调用参数错配（请求支持文件，包络却声称 SKILL.md）。
    parent.callTool.mockResolvedValueOnce({
      value: { content: [{ type: 'text', text: JSON.stringify({
        name: 'demo',
        description: '示例',
        source: 'user',
        file: 'SKILL.md',
        content: '正文',
        supportFiles: [],
      }) }] },
      effect: {
        kind: 'read',
        executionStarted: true,
        completed: true,
        resources: [],
        reason: 'declared_read_tool',
      },
    });
    await agent.callTool('load_skill', { name: 'demo', file_path: 'references/a.md' });
    expect(ledger.getRecord('demo', 'references/a.md')).toBeUndefined();

    // 非法 JSON 文本。
    parent.callTool.mockResolvedValueOnce({
      value: { content: [{ type: 'text', text: '{broken json' }] },
      effect: {
        kind: 'read',
        executionStarted: true,
        completed: true,
        resources: [],
        reason: 'declared_read_tool',
      },
    });
    await agent.callTool('load_skill', { name: 'broken' });
    expect(ledger.getRecord('broken', null)).toBeUndefined();
  });

  it('模型输出会被折叠时不为完整正文签发读取凭证', async () => {
    const ledger = new SkillReviewReadLedger('background-skill-review:test');
    const parent = createParentRegistry();
    // 合法 JSON 包络但 content 超过统一默认 50KB 配额：模型只能看到折叠预览。
    parent.callTool.mockResolvedValueOnce({
      value: { content: [{ type: 'text', text: JSON.stringify({
        name: 'oversized',
        description: '示例',
        source: 'user',
        file: 'SKILL.md',
        content: 'x'.repeat(60 * 1024),
        supportFiles: [],
      }) }] },
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
      parentToolNames: ['skills_list', 'load_skill', 'skill_manage'],
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

  it('按最终 CallToolResult 序列化判断配额，不为二次转义后折叠的内容签发凭证', async () => {
    const ledger = new SkillReviewReadLedger('background-skill-review:test');
    const parent = createParentRegistry();
    parent.getTool.mockImplementation((name: string) => ({
      name,
      securityCategory: name === 'skill_manage' ? 'write' as const : 'read' as const,
      ...(name === 'load_skill' ? { maxBytes: 640 * 1024 } : {}),
    }));
    const modelVisibleText = JSON.stringify({
      name: 'escape-heavy',
      description: '示例',
      source: 'user',
      file: 'SKILL.md',
      content: '\u0001'.repeat(95_000),
      supportFiles: [],
    });
    const outcomeValue = { content: [{ type: 'text', text: modelVisibleText }] };
    // 内层文本未超 640KB，但生产路径的外层 CallToolResult 二次转义后会超限。
    expect(Buffer.byteLength(modelVisibleText, 'utf8')).toBeLessThan(640 * 1024);
    expect(Buffer.byteLength(serializeToolOutcomeForModel(outcomeValue), 'utf8'))
      .toBeGreaterThan(640 * 1024);
    parent.callTool.mockResolvedValueOnce({
      value: outcomeValue,
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
      parentToolNames: ['skills_list', 'load_skill', 'skill_manage'],
      callerId: 'background-skill-review:test',
      readLedger: ledger,
    });

    await agent.callTool('load_skill', { name: 'escape-heavy' });

    expect(ledger.getRecord('escape-heavy', null)).toBeUndefined();
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
