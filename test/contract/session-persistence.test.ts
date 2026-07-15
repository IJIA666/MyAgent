/**
 * @fileoverview 会话持久化合约测试。
 * 使用真实 ContextRepository 验证 saveState() → JSON 快照 → loadState() 的完整性，
 * 覆盖 messages、历史中段摘要消息和合法 pendingInteraction 字段。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
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
});
