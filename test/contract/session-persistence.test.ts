/**
 * @fileoverview 会话持久化合约测试。
 * 使用真实 ContextRepository 验证 saveState() → JSON 快照 → loadState() 的完整性，
 * 覆盖 messages、历史中段摘要、pendingInteraction 和 Skill 学习延续字段。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { ContextRepository } from '../../src/core/usecases/brain/ContextRepository.js';
import { SessionContext } from '../../src/core/domain/context.js';

const tempWorkspaces: string[] = [];

/** 创建并记录当前测试专用的会话工作区。 */
function createTempWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), 'contract-session-'));
  tempWorkspaces.push(workspace);
  return workspace;
}

afterEach(() => {
  for (const workspace of tempWorkspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

describe('Session 持久化合约测试 — saveState / loadState', () => {
  it('空会话 saveState → loadState 不丢字段', async () => {
    // ContextRepository 构造函数接收会话实例和工作区路径
    const session = new SessionContext('contract-persistence-empty');
    session.addMessage({ role: 'user', content: 'hello' });
    session.addMessage({ role: 'assistant', content: 'world' });

    const workspace = createTempWorkspace();
    const repo = new ContextRepository(session, workspace);
    await repo.saveState();

    // 创建新会话和仓储加载状态
    const loadedSession = new SessionContext('contract-persistence-loaded');
    const loadRepo = new ContextRepository(loadedSession, workspace);
    const found = await loadRepo.loadState(session.getSessionId());

    expect(found).toBe(true);
    // saveState 保存 3 条（auto system + hello + world），loadState 回写至 loadedSession
    const loadedHistory = loadedSession.getHistory();
    expect(loadedHistory).toHaveLength(3);
    expect(loadedHistory[0].role).toBe('system');
    expect(loadedHistory[1].content).toBe('hello');
    expect(loadedHistory[2].content).toBe('world');
  });

  it('含历史中段摘要与 pendingInteraction 的会话完整恢复', async () => {
    const session = new SessionContext('contract-persistence-full');

    // SessionContext 构造自动注入一条 system prompt。再加 4 条 = 共 5 条
    session.addMessage({ role: 'user', content: 'first message' });
    session.addMessage({ role: 'assistant', content: 'reply', reasoning_content: 'thinking...' });
    session.addMessage({
      role: 'tool',
      content: 'tool result',
      tool_call_id: 'tc-001',
      name: 'readFile',
    });
    // 中段摘要作为普通历史消息持久化，不再维护第二份 Checkpoint 状态。
    session.addMessage({
      role: 'user',
      content: '[Summary of Earlier Conversation]\n历史提炼摘要内容',
    });
    session.addMessage({ role: 'user', content: 'latest request' });

    session.setPendingInteraction({
      id: 'pending-001',
      toolName: 'ask_user_question',
      toolCallId: 'tool-call-001',
      payload: {
        questions: [{
          id: 'choice',
          header: 'Choice',
          question: 'Continue?',
          mode: 'single-select',
          options: [{ label: 'Yes' }],
        }],
      },
    });

    const workspace = createTempWorkspace();
    const repo = new ContextRepository(session, workspace);
    await repo.saveState();

    // 创建新会话和仓储加载状态
    const loadedSession = new SessionContext('contract-persistence-reloaded');
    const loadRepo = new ContextRepository(loadedSession, workspace);
    const found = await loadRepo.loadState(session.getSessionId());

    expect(found).toBe(true);

    // 验证消息无损（auto system + user + assistant + tool + summary + latest）
    const history = loadedSession.getHistory();
    expect(history).toHaveLength(6);
    // history[0] 为 auto system prompt（动态生成，不校验具体内容）
    expect(history[0].role).toBe('system');
    expect(history[1].content).toBe('first message');
    expect(history[2].content).toBe('reply');
    expect(history[3].content).toBe('tool result');
    expect(history[3].tool_call_id).toBe('tc-001');
    expect(history[4].content).toContain('历史提炼摘要内容');
    expect(history[5].content).toBe('latest request');

    expect(loadedSession.pendingInteraction).toMatchObject({
      id: 'pending-001',
      toolName: 'ask_user_question',
      toolCallId: 'tool-call-001',
      state: 'pending',
      payload: { questions: [{ id: 'choice', question: 'Continue?' }] },
    });
  });

  it('新会话不恢复旧会话临时模式（仅使用未来默认）', async () => {
    const session = new SessionContext('contract-persistence-mode');
    expect(session.getPermissionMode()).toBe('default');

    // 切换到 acceptEdits（临时会话模式）
    session.setPermissionMode('acceptEdits');
    expect(session.getPermissionMode()).toBe('acceptEdits');

    const workspace = createTempWorkspace();
    const repo = new ContextRepository(session, workspace);
    await repo.saveState();

    // 新会话加载同一持久化快照，但不继承临时的 acceptEdits
    const loadedSession = new SessionContext('contract-persistence-mode-loaded');
    const loadRepo = new ContextRepository(loadedSession, workspace);
    await loadRepo.loadState(session.getSessionId());

    // 新会话应从头使用配置默认值，而不是恢复旧的 acceptEdits
    expect(loadedSession.getPermissionMode()).toBe('default');
  });

  it('waiting_for_interaction 的 Skill 学习证据可跨进程快照恢复', async () => {
    const session = new SessionContext('contract-persistence-skill-learning');
    session.setSkillLearningContinuation({
      version: 2,
      foregroundSkillMutationHandled: false,
      trajectory: [
        { role: 'user', content: '发布纯文字帖子' },
        { role: 'tool', tool_call_id: 'publisher-check', content: '需要绑定手机号' },
      ],
      loadedSkills: ['social-posting'],
      toolEvidence: [{
        toolCallId: 'publisher-check',
        toolName: 'browser_get_text',
        status: 'success',
        resultSummary: '创作中心返回手机号绑定前置条件',
      }],
      toolIterationCount: 17,
      requestedToolCallCount: 20,
      segmentCount: 1,
      resumeHistoryIndex: session.getHistory().length,
    });

    const workspace = createTempWorkspace();
    await new ContextRepository(session, workspace).saveState();

    const loadedSession = new SessionContext('contract-persistence-skill-learning-loaded');
    const found = await new ContextRepository(loadedSession, workspace)
      .loadState(session.getSessionId());

    expect(found).toBe(true);
    expect(loadedSession.getSkillLearningContinuation()).toEqual(
      session.getSkillLearningContinuation(),
    );
  });

  it('未达阈值的 Skill 学习累计跨快照恢复，损坏字段 fail-closed 归零', async () => {
    const workspace = createTempWorkspace();

    // 保存已累计 7 次的快照。
    const session = new SessionContext('contract-persistence-cadence');
    session.setSkillLearningCadence({
      version: 1,
      accumulatedToolResponseIterations: 7,
    });
    await new ContextRepository(session, workspace).saveState();

    // 恢复同一会话：累计值 7 继续使用，不重置为零。
    const loadedSession = new SessionContext('contract-persistence-cadence-loaded');
    await new ContextRepository(loadedSession, workspace)
      .loadState(session.getSessionId());
    expect(loadedSession.getSkillLearningCadence()).toMatchObject({
      accumulatedToolResponseIterations: 7,
    });

    // 损坏字段（负数/未知版本）按零累计恢复，且不阻止其他状态恢复。
    const damagedSession = new SessionContext('contract-persistence-cadence-damaged');
    damagedSession.addMessage({ role: 'user', content: '合法消息' });
    damagedSession.setSkillLearningCadence({
      version: 1,
      accumulatedToolResponseIterations: 7,
    });
    await new ContextRepository(damagedSession, workspace).saveState();
    const raw = JSON.parse(
      readFileSync(resolve(workspace, `session_${damagedSession.getSessionId()}.json`), 'utf8'),
    ) as { skillLearningCadence: { version: number; accumulatedToolResponseIterations: number } };
    raw.skillLearningCadence = { version: 99, accumulatedToolResponseIterations: -3 };
    writeFileSync(
      resolve(workspace, `session_${damagedSession.getSessionId()}.json`),
      JSON.stringify(raw, null, 2),
      'utf8',
    );

    const repairedSession = new SessionContext('contract-persistence-cadence-repaired');
    await new ContextRepository(repairedSession, workspace)
      .loadState(damagedSession.getSessionId());
    // 损坏字段不得阻止合法消息历史恢复。
    expect(repairedSession.getHistory().some(
      message => message.role === 'user' && message.content === '合法消息',
    )).toBe(true);
    expect(repairedSession.getSkillLearningCadence()).toMatchObject({
      accumulatedToolResponseIterations: 0,
    });
  });

  it('加载旧版数组快照时清空当前上下文中的临时交互与学习状态', async () => {
    const workspace = createTempWorkspace();
    const legacySessionId = 'contract-persistence-legacy-array';
    writeFileSync(
      resolve(workspace, `session_${legacySessionId}.json`),
      JSON.stringify([{ role: 'user', content: '旧版会话消息' }]),
      'utf8',
    );

    // 模拟仓储复用：加载前的 Context 已残留另一会话的临时状态。
    const loadedSession = new SessionContext('contract-persistence-legacy-target');
    loadedSession.setPendingInteraction({
      id: 'stale-pending',
      toolName: 'ask_user_question',
      toolCallId: 'stale-tool-call',
      payload: {
        questions: [{
          id: 'choice',
          header: 'Choice',
          question: 'Continue?',
          mode: 'single-select',
          options: [{ label: 'Yes' }],
        }],
      },
    });
    loadedSession.setSkillLearningContinuation({
      version: 2,
      foregroundSkillMutationHandled: false,
      trajectory: [{ role: 'user', content: '不应泄漏的轨迹' }],
      loadedSkills: ['stale-skill'],
      toolEvidence: [],
      toolIterationCount: 3,
      requestedToolCallCount: 3,
      segmentCount: 1,
      resumeHistoryIndex: 1,
    });
    loadedSession.setSkillLearningCadence({
      version: 1,
      accumulatedToolResponseIterations: 9,
    });

    const found = await new ContextRepository(loadedSession, workspace)
      .loadState(legacySessionId);

    expect(found).toBe(true);
    expect(loadedSession.pendingInteraction).toBeNull();
    expect(loadedSession.getSkillLearningContinuation()).toBeNull();
    expect(loadedSession.getSkillLearningCadence()).toMatchObject({
      accumulatedToolResponseIterations: 0,
    });
    expect(loadedSession.getHistory()).toEqual([
      { role: 'user', content: '旧版会话消息' },
    ]);
  });
});
