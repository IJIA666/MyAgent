/**
 * @file SkillLearningPlugin 的累计阈值、成功门槛与非阻塞排队测试。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../../../../src/core/domain/context.js';
import {
  SkillLearningPlugin,
  type BackgroundSkillReviewRequest,
  type BackgroundSkillReviewScheduler,
} from '../../../../src/core/usecases/plugins/SkillLearningPlugin.js';
import {
  HookEventName,
  type AgentRunSummary,
  type HookContext,
} from '../../../../src/core/usecases/plugins/plugin-types.js';

/** 构造指定工具迭代数的成功 RunEnd 摘要。 */
function completedSummary(
  toolIterationCount: number,
  historyStartIndex = 0,
  historyEndIndex = 0,
): AgentRunSummary {
  return {
    terminalStatus: 'completed',
    toolIterationCount,
    requestedToolCallCount: toolIterationCount,
    historyStartIndex,
    historyEndIndex,
    hasFinalResponse: true,
    waitingForInteraction: false,
  };
}

/** 构造最小 HookContext。 */
function hookContext(
  sessionContext: SessionContext,
  eventName: HookEventName,
  extra: Partial<HookContext> = {},
): HookContext {
  return {
    sessionContext,
    eventName,
    control: { action: 'continue' },
    ...extra,
  };
}

describe('SkillLearningPlugin', () => {
  let sessionContext: SessionContext;
  let scheduled: BackgroundSkillReviewRequest[];
  let scheduler: BackgroundSkillReviewScheduler;

  beforeEach(() => {
    sessionContext = new SessionContext('skill-learning-test');
    scheduled = [];
    scheduler = {
      schedule: vi.fn((request: Readonly<BackgroundSkillReviewRequest>) => {
        scheduled.push(request as BackgroundSkillReviewRequest);
      }),
    };
  });

  it('应跨 run 累计工具迭代，达到阈值后排队并归零', async () => {
    const plugin = new SkillLearningPlugin({
      backgroundReviewEnabled: true,
      creationNudgeInterval: 3,
    }, scheduler);
    const next = vi.fn().mockResolvedValue(undefined);

    await plugin.hooks[HookEventName.RunStart](
      hookContext(sessionContext, HookEventName.RunStart),
      next,
    );
    await plugin.hooks[HookEventName.RunEnd](
      hookContext(sessionContext, HookEventName.RunEnd, {
        runSummary: completedSummary(1),
      }),
      next,
    );
    expect(scheduler.schedule).not.toHaveBeenCalled();

    sessionContext.addMessage({ role: 'user', content: '第二个任务' });
    const start = sessionContext.getHistory().length;
    await plugin.hooks[HookEventName.RunStart](
      hookContext(sessionContext, HookEventName.RunStart),
      next,
    );
    sessionContext.addMessage({ role: 'assistant', content: '完成' });
    await plugin.hooks[HookEventName.RunEnd](
      hookContext(sessionContext, HookEventName.RunEnd, {
        runSummary: completedSummary(2, start, sessionContext.getHistory().length),
      }),
      next,
    );

    expect(scheduler.schedule).toHaveBeenCalledTimes(1);
    expect(scheduled[0].trajectory).toEqual([
      { role: 'assistant', content: '完成' },
    ]);

    await plugin.hooks[HookEventName.RunStart](
      hookContext(sessionContext, HookEventName.RunStart),
      next,
    );
    await plugin.hooks[HookEventName.RunEnd](
      hookContext(sessionContext, HookEventName.RunEnd, {
        runSummary: completedSummary(2),
      }),
      next,
    );
    expect(scheduler.schedule).toHaveBeenCalledTimes(1);
  });

  it('应记录成功加载的 Skill 和有界结构化工具证据', async () => {
    const plugin = new SkillLearningPlugin({
      backgroundReviewEnabled: true,
      creationNudgeInterval: 1,
    }, scheduler);
    const next = vi.fn().mockResolvedValue(undefined);
    const toolCall = {
      id: 'load-skill-1',
      type: 'function' as const,
      function: {
        name: 'load_skill',
        arguments: JSON.stringify({ name: 'text-posting' }),
      },
    };

    await plugin.hooks[HookEventName.RunStart](
      hookContext(sessionContext, HookEventName.RunStart),
      next,
    );
    await plugin.hooks[HookEventName.AfterModel](
      hookContext(sessionContext, HookEventName.AfterModel, {
        llmResponse: {
          role: 'assistant',
          content: '先加载已有技能',
          tool_calls: [toolCall],
        },
      }),
      next,
    );
    await plugin.hooks[HookEventName.AfterTool](
      hookContext(sessionContext, HookEventName.AfterTool, {
        toolCall: {
          id: toolCall.id,
          name: 'load_skill',
          arguments: { name: 'text-posting' },
        },
        toolResult: {
          content: 'x'.repeat(2_100),
          isError: false,
        },
      }),
      next,
    );
    await plugin.hooks[HookEventName.RunEnd](
      hookContext(sessionContext, HookEventName.RunEnd, {
        runSummary: completedSummary(1),
      }),
      next,
    );

    expect(scheduled[0].loadedSkills).toEqual(['text-posting']);
    expect(scheduled[0].toolEvidence).toMatchObject([{
      toolCallId: 'load-skill-1',
      toolName: 'load_skill',
      status: 'success',
    }]);
    expect(scheduled[0].toolEvidence[0].resultSummary.length).toBeLessThan(2_100);
  });

  it.each([
    ['error', false, false],
    ['aborted', false, false],
    ['waiting_for_interaction', false, true],
  ] as const)('终态 %s 不应累计或安排复盘', async (
    terminalStatus,
    hasFinalResponse,
    waitingForInteraction,
  ) => {
    const plugin = new SkillLearningPlugin({
      backgroundReviewEnabled: true,
      creationNudgeInterval: 1,
    }, scheduler);
    const next = vi.fn().mockResolvedValue(undefined);
    await plugin.hooks[HookEventName.RunStart](
      hookContext(sessionContext, HookEventName.RunStart),
      next,
    );
    await plugin.hooks[HookEventName.RunEnd](
      hookContext(sessionContext, HookEventName.RunEnd, {
        runSummary: {
          ...completedSummary(10),
          terminalStatus,
          hasFinalResponse,
          waitingForInteraction,
        },
      }),
      next,
    );
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });

  it('关闭后台复盘时不得累计，重新创建启用实例后从零开始', async () => {
    const disabledPlugin = new SkillLearningPlugin({
      backgroundReviewEnabled: false,
      creationNudgeInterval: 1,
    }, scheduler);
    const next = vi.fn().mockResolvedValue(undefined);
    await disabledPlugin.hooks[HookEventName.RunEnd](
      hookContext(sessionContext, HookEventName.RunEnd, {
        runSummary: completedSummary(10),
      }),
      next,
    );
    expect(scheduler.schedule).not.toHaveBeenCalled();

    const enabledPlugin = new SkillLearningPlugin({
      backgroundReviewEnabled: true,
      creationNudgeInterval: 2,
    }, scheduler);
    await enabledPlugin.hooks[HookEventName.RunEnd](
      hookContext(sessionContext, HookEventName.RunEnd, {
        runSummary: completedSummary(1),
      }),
      next,
    );
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });
});
