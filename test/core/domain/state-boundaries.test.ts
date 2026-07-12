/**
 * @fileoverview 核心领域状态边界测试。
 * 覆盖会话消息状态、交互中断状态及 SessionContext 的忙锁和授权白名单委托。
 */

import { describe, expect, it } from 'vitest';
import { ConversationState } from '../../../src/core/domain/conversation-state.js';
import { InteractionState } from '../../../src/core/domain/interaction-state.js';
import { SessionContext } from '../../../src/core/domain/context.js';
import type { PendingInteraction } from '../../../src/ports/shared/pending-interaction.js';
import type { StoredChatMessage } from '../../../src/core/domain/conversation-state.js';

/** 构造测试用的普通会话消息。 */
function message(content: string): StoredChatMessage {
  return { role: 'user', content };
}

/** 构造测试用的待回答交互记录。 */
function pendingInteraction(id: string): Omit<PendingInteraction, 'state' | 'createdAt'> {
  return {
    id,
    toolName: 'ask_user_question',
    toolCallId: `call-${id}`,
    payload: { questions: [] },
  };
}

describe('ConversationState 边界行为', () => {
  it('应正确处理空历史、系统提示词、截断和回滚', () => {
    const emptyState = new ConversationState();
    expect(emptyState.getHistory()).toEqual([]);
    expect(emptyState.getSystemPromptHash()).toBe('');
    emptyState.updateSystemPrompt('ignored');
    expect(emptyState.getHistory()).toEqual([]);

    const state = new ConversationState('system');
    state.addMessage(message('one'));
    state.addMessage(message('two'));
    state.addMessage(message('three'));

    const originalLength = state.getHistory().length;
    state.truncateHistory(10);
    expect(state.getHistory()).toHaveLength(originalLength);
    state.truncateHistory(2);
    expect(state.getHistory().map(item => item.content)).toEqual(['system', 'two', 'three']);

    state.truncateHistoryFromIndex(1);
    expect(state.getHistory()).toHaveLength(3);
    state.truncateHistoryFromIndex(3);
    expect(state.getHistory()).toHaveLength(3);
    state.truncateHistoryFromIndex(2);
    expect(state.getHistory().map(item => item.content)).toEqual(['system', 'three']);

    expect(() => state.rollbackHistoryToLength(-1)).toThrow('Invalid rollback length');
    expect(() => state.rollbackHistoryToLength(3)).toThrow('Invalid rollback length');
    state.rollbackHistoryToLength(1);
    expect(state.getHistory()).toHaveLength(1);
  });

  it('应只更新系统提示词并正确处理非字符串内容与 Usage 基线', () => {
    const state = new ConversationState();
    state.updateHistory([{ role: 'user', content: 'user message' }]);
    state.updateSystemPrompt('ignored');
    expect(state.getHistory()[0].content).toBe('user message');
    expect(state.getSystemPromptHash()).toBe('');

    state.updateHistory([{ role: 'system', content: null }]);
    expect(state.getSystemPromptHash()).toBe('');
    state.updateSystemPrompt('updated system');
    expect(state.getHistory()[0].content).toBe('updated system');
    expect(state.getSystemPromptHash()).not.toBe('');

    expect(state.getLastApiUsage()).toBeNull();
    expect(state.getLastApiUsageBaseline()).toEqual({ usage: null, historyLength: 0 });
    const usage = { input_tokens: 10, output_tokens: 2 };
    state.updateLastApiUsage(usage, 4);
    expect(state.getLastApiUsage()).toEqual(usage);
    expect(state.getLastApiUsageBaseline()).toEqual({ usage, historyLength: 4 });
  });
});

describe('InteractionState 边界行为', () => {
  it('应缓冲通知并完整管理待回答、已回答和已取消状态', () => {
    const state = new InteractionState();
    expect(state.isProcessing).toBe(false);
    state.isProcessing = true;
    expect(state.isProcessing).toBe(true);
    state.isProcessing = false;
    expect(state.pendingInteraction).toBeNull();

    const notification = message('notification');
    state.bufferNotification(notification);
    expect(state.drainPendingNotifications()).toEqual([notification]);
    expect(state.drainPendingNotifications()).toEqual([]);
    expect(state.answerPendingInteraction({ question: 'answer' })).toBeNull();
    state.cancelPendingInteraction();
    state.clearPendingInteraction();

    const created = state.setPendingInteraction(pendingInteraction('first'));
    expect(created.state).toBe('pending');
    expect(created.createdAt).toBeTypeOf('number');
    expect(() => state.setPendingInteraction(pendingInteraction('second'))).toThrow('并发创建');

    const answered = state.answerPendingInteraction({ question: 'answer' });
    expect(answered?.state).toBe('answered');
    expect(answered?.answer).toEqual({ question: 'answer' });
    expect(state.answerPendingInteraction({ question: 'ignored' })).toBeNull();

    const replacement = state.setPendingInteraction(pendingInteraction('replacement'));
    expect(replacement.id).toBe('replacement');
    state.cancelPendingInteraction();
    expect(state.pendingInteraction?.state).toBe('canceled');
    expect(state.answerPendingInteraction({ question: 'ignored' })).toBeNull();

    state.restorePendingInteraction({
      ...pendingInteraction('restored'),
      state: 'pending',
      createdAt: 1,
    });
    expect(state.pendingInteraction?.id).toBe('restored');
    state.clearPendingInteraction();
    expect(state.pendingInteraction).toBeNull();
  });
});

describe('SessionContext 状态边界', () => {
  it('应支持正常状态变更并阻止忙状态下的受保护操作', () => {
    const context = new SessionContext('state-boundaries');
    context.setTenantId('tenant-a');
    context.setSessionId('state-boundaries-updated');
    context.setPermissionMode('auto');
    expect(context.getTenantId()).toBe('tenant-a');
    expect(context.getSessionId()).toBe('state-boundaries-updated');
    expect(context.getPermissionMode()).toBe('auto');

    context.addMessage(message('one'));
    context.addMessage(message('two'));
    context.addMessage(message('three'));
    context.rollbackHistoryToLength(2);
    expect(context.getHistory()).toHaveLength(2);
    expect(() => context.rollbackHistoryToLength(3)).toThrow('Invalid rollback length');
    context.addMessage(message('three-again'));
    context.addMessage(message('four'));
    context.truncateHistoryFromIndex(2);
    expect(context.getHistory()).toHaveLength(3);

    context.addTemporaryReadWhitelist('state-boundaries-read');
    context.addTemporaryWriteWhitelist('state-boundaries-write');
    context.addTemporaryDirectoryScopeReadWhitelist('state-boundaries-directory');
    expect(context.hasTemporaryReadWhitelist('state-boundaries-read')).toBe(true);
    expect(context.hasTemporaryWriteWhitelist('state-boundaries-write')).toBe(true);
    context.clearTemporaryWhitelists();
    expect(context.hasTemporaryReadWhitelist('state-boundaries-read')).toBe(false);

    context.isProcessing = true;
    expect(() => context.setTenantId('blocked')).toThrow('session is currently busy');
    expect(() => context.setPermissionMode('default')).toThrow('session is currently busy');
    expect(() => context.rollbackHistoryToLength(0)).toThrow('session is currently busy');
    expect(() => context.truncateHistoryFromIndex(1)).toThrow('session is currently busy');
    expect(() => context.addTemporaryReadWhitelist('blocked-read')).toThrow('session is currently busy');
    expect(() => context.addTemporaryWriteWhitelist('blocked-write')).toThrow('session is currently busy');
    expect(() => context.addTemporaryDirectoryScopeReadWhitelist('blocked-directory')).toThrow('session is currently busy');
    expect(() => context.clearTemporaryWhitelists()).toThrow('session is currently busy');
    context.isProcessing = false;
  });

  it('应通过 SessionContext 委托交互回答和取消操作', () => {
    const context = new SessionContext('state-boundaries-interaction');
    expect(context.answerPendingInteraction({ question: 'none' })).toBeNull();

    context.setPendingInteraction(pendingInteraction('context-interaction'));
    const answered = context.answerPendingInteraction({ question: 'yes' });
    expect(answered?.state).toBe('answered');
    expect(answered?.answer).toEqual({ question: 'yes' });

    context.setPendingInteraction(pendingInteraction('context-cancel'));
    context.cancelPendingInteraction();
    expect(context.pendingInteraction?.state).toBe('canceled');
    context.clearPendingInteraction();
    expect(context.pendingInteraction).toBeNull();
  });
});
