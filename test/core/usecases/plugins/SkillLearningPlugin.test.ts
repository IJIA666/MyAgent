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
import { runHookPipeline } from '../../../../src/core/usecases/plugins/plugin-runner.js';

/** 构造指定工具迭代数的成功 RunEnd 摘要。 */
function completedSummary(
  toolIterationCount: number,
  learningTrajectoryStartIndex = 0,
  historyEndIndex = 0,
): AgentRunSummary {
  return {
    terminalStatus: 'completed',
    toolIterationCount,
    requestedToolCallCount: toolIterationCount,
    physicalRunStartIndex: 0,
    learningTrajectoryStartIndex,
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
        return { accepted: true, taskId: 'test-task' };
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

  it('waiting_for_interaction 应保存证据，并在恢复完成后按同一学习单元复盘', async () => {
    const plugin = new SkillLearningPlugin({
      backgroundReviewEnabled: true,
      creationNudgeInterval: 10,
    }, scheduler);
    const next = vi.fn().mockResolvedValue(undefined);
    const waitingStart = sessionContext.getHistory().length;

    await plugin.hooks[HookEventName.RunStart](
      hookContext(sessionContext, HookEventName.RunStart),
      next,
    );
    sessionContext.addMessage({ role: 'user', content: '探索纯文字发帖入口' });
    await plugin.hooks[HookEventName.AfterTool](
      hookContext(sessionContext, HookEventName.AfterTool, {
        toolCall: {
          id: 'open-publisher',
          name: 'browser_navigate',
          arguments: { url: 'https://creator.example.test' },
        },
        toolResult: {
          content: '已进入创作中心，等待用户完成账号绑定',
          isError: false,
        },
      }),
      next,
    );
    sessionContext.addMessage({
      role: 'assistant',
      content: '需要用户确认后继续',
      tool_calls: [{
        id: 'ask-binding',
        type: 'function',
        function: {
          name: 'ask_user_question',
          arguments: '{"questions":[]}',
        },
      }],
    });
    await runHookPipeline(
      HookEventName.RunEnd,
      sessionContext,
      [plugin.hooks[HookEventName.RunEnd]],
      {
        runSummary: {
          ...completedSummary(
            9,
            waitingStart,
            sessionContext.getHistory().length,
          ),
          terminalStatus: 'waiting_for_interaction',
          hasFinalResponse: false,
          waitingForInteraction: true,
        },
      },
    );

    expect(scheduler.schedule).not.toHaveBeenCalled();
    expect(sessionContext.getSkillLearningContinuation()).toMatchObject({
      toolIterationCount: 9,
      requestedToolCallCount: 9,
      segmentCount: 1,
    });

    // 真实恢复链路会在下一个 RunStart 前补入 ask_user_question 的工具回答；
    // 恢复 run 的学习起点 = 延续状态的恢复边界（等待 run 结束时的历史长度）。
    sessionContext.addMessage({
      role: 'tool',
      tool_call_id: 'ask-binding',
      content: '{"continue":"已完成绑定"}',
    });
    const resumedStart = sessionContext.getSkillLearningContinuation()?.resumeHistoryIndex;
    await plugin.hooks[HookEventName.RunStart](
      hookContext(sessionContext, HookEventName.RunStart),
      next,
    );
    sessionContext.addMessage({ role: 'assistant', content: '帖子发布完成' });
    await plugin.hooks[HookEventName.RunEnd](
      hookContext(sessionContext, HookEventName.RunEnd, {
        runSummary: completedSummary(
          1,
          resumedStart as number,
          sessionContext.getHistory().length,
        ),
      }),
      next,
    );

    expect(scheduler.schedule).toHaveBeenCalledTimes(1);
    expect(sessionContext.getSkillLearningContinuation()).toBeNull();
    expect(scheduled[0].trajectory).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: '探索纯文字发帖入口' }),
      expect.objectContaining({
        role: 'tool',
        tool_call_id: 'ask-binding',
        content: '{"continue":"已完成绑定"}',
      }),
      expect.objectContaining({ role: 'assistant', content: '帖子发布完成' }),
    ]));
    expect(scheduled[0].toolEvidence).toMatchObject([{
      toolCallId: 'open-publisher',
      toolName: 'browser_navigate',
      status: 'success',
    }]);
  });

  it('等待后的失败终态应丢弃延续证据且不得污染后续任务', async () => {
    const plugin = new SkillLearningPlugin({
      backgroundReviewEnabled: true,
      creationNudgeInterval: 2,
    }, scheduler);
    const next = vi.fn().mockResolvedValue(undefined);

    await plugin.hooks[HookEventName.RunStart](
      hookContext(sessionContext, HookEventName.RunStart),
      next,
    );
    await plugin.hooks[HookEventName.RunEnd](
      hookContext(sessionContext, HookEventName.RunEnd, {
        runSummary: {
          ...completedSummary(2),
          terminalStatus: 'waiting_for_interaction',
          hasFinalResponse: false,
          waitingForInteraction: true,
        },
      }),
      next,
    );
    expect(sessionContext.getSkillLearningContinuation()).not.toBeNull();

    await plugin.hooks[HookEventName.RunStart](
      hookContext(sessionContext, HookEventName.RunStart),
      next,
    );
    await plugin.hooks[HookEventName.RunEnd](
      hookContext(sessionContext, HookEventName.RunEnd, {
        runSummary: {
          ...completedSummary(0),
          terminalStatus: 'aborted',
          hasFinalResponse: false,
        },
      }),
      next,
    );
    expect(sessionContext.getSkillLearningContinuation()).toBeNull();

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

  it('内部生成缺少学习轨迹起点时应 fail-closed，不推进累计也不安排复盘', async () => {
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
          ...completedSummary(5),
          learningTrajectoryStartIndex: null,
        },
      }),
      next,
    );
    expect(scheduler.schedule).not.toHaveBeenCalled();

    // 内部生成的证据被丢弃：后续合法任务仍从零累计。
    sessionContext.addMessage({ role: 'user', content: '真实任务' });
    const start = sessionContext.getHistory().length;
    await plugin.hooks[HookEventName.RunStart](
      hookContext(sessionContext, HookEventName.RunStart),
      next,
    );
    sessionContext.addMessage({ role: 'assistant', content: '完成' });
    await plugin.hooks[HookEventName.RunEnd](
      hookContext(sessionContext, HookEventName.RunEnd, {
        runSummary: completedSummary(1, start, sessionContext.getHistory().length),
      }),
      next,
    );
    // 若内部生成的 5 次迭代被错误计入，首次 RunEnd 即会触发调度。
    expect(scheduler.schedule).toHaveBeenCalledTimes(1);
  });

  it('学习轨迹起点越界时应 fail-closed 丢弃证据', async () => {
    const plugin = new SkillLearningPlugin({
      backgroundReviewEnabled: true,
      creationNudgeInterval: 1,
    }, scheduler);
    const next = vi.fn().mockResolvedValue(undefined);
    await plugin.hooks[HookEventName.RunStart](
      hookContext(sessionContext, HookEventName.RunStart),
      next,
    );
    sessionContext.addMessage({ role: 'user', content: '任务' });
    await plugin.hooks[HookEventName.RunEnd](
      hookContext(sessionContext, HookEventName.RunEnd, {
        runSummary: {
          ...completedSummary(3, 0, sessionContext.getHistory().length),
          // 起点远超当前历史，视为越界。
          learningTrajectoryStartIndex: 999,
        },
      }),
      next,
    );
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });

  it('恢复 run 的学习起点与延续恢复边界不一致时应 fail-closed 并清除延续状态', async () => {
    const plugin = new SkillLearningPlugin({
      backgroundReviewEnabled: true,
      creationNudgeInterval: 1,
    }, scheduler);
    const next = vi.fn().mockResolvedValue(undefined);
    // 第一次等待保存延续状态，恢复边界为 0。
    await plugin.hooks[HookEventName.RunStart](
      hookContext(sessionContext, HookEventName.RunStart),
      next,
    );
    await plugin.hooks[HookEventName.RunEnd](
      hookContext(sessionContext, HookEventName.RunEnd, {
        runSummary: {
          ...completedSummary(1),
          terminalStatus: 'waiting_for_interaction',
          hasFinalResponse: false,
          waitingForInteraction: true,
        },
      }),
      next,
    );
    expect(sessionContext.getSkillLearningContinuation()).not.toBeNull();

    // 用户没有通过恢复入口回答，而是直接追加了新消息：学习起点指向新位置。
    sessionContext.addMessage({
      role: 'tool',
      tool_call_id: 'ask-1',
      content: '{"continue":"已完成"}',
    });
    const wrongStart = sessionContext.getHistory().length;
    sessionContext.addMessage({ role: 'user', content: '绕过交互的新任务' });
    await plugin.hooks[HookEventName.RunStart](
      hookContext(sessionContext, HookEventName.RunStart),
      next,
    );
    await plugin.hooks[HookEventName.RunEnd](
      hookContext(sessionContext, HookEventName.RunEnd, {
        runSummary: completedSummary(1, wrongStart, sessionContext.getHistory().length),
      }),
      next,
    );
    expect(scheduler.schedule).not.toHaveBeenCalled();
    // 失败路径必须清除陈旧延续状态，防止后续 run 反复触发同一非法边界。
    expect(sessionContext.getSkillLearningContinuation()).toBeNull();
  });

  it('多段等待后完成应合并各段轨迹且消息不重复', async () => {
    const plugin = new SkillLearningPlugin({
      backgroundReviewEnabled: true,
      creationNudgeInterval: 2,
    }, scheduler);
    const next = vi.fn().mockResolvedValue(undefined);

    // 第一段：用户任务开始，等待一次交互。
    // 学习起点指向用户消息本身，需在 addMessage 前捕获（历史首条是 system 消息）。
    const segmentOneStart = sessionContext.getHistory().length;
    sessionContext.addMessage({ role: 'user', content: '第一段用户任务' });
    await plugin.hooks[HookEventName.RunStart](
      hookContext(sessionContext, HookEventName.RunStart),
      next,
    );
    sessionContext.addMessage({ role: 'assistant', content: '需要确认', tool_calls: [{
      id: 'ask-1',
      type: 'function',
      function: { name: 'ask_user_question', arguments: '{}' },
    }] });
    await runHookPipeline(
      HookEventName.RunEnd,
      sessionContext,
      [plugin.hooks[HookEventName.RunEnd]],
      {
        runSummary: {
          ...completedSummary(1, segmentOneStart, sessionContext.getHistory().length),
          terminalStatus: 'waiting_for_interaction',
          hasFinalResponse: false,
          waitingForInteraction: true,
        },
      },
    );

    // 第二段：回答后恢复，再次等待。
    // 恢复 run 的学习起点 = 延续恢复边界（上一段 RunEnd 时的历史长度）。
    const segmentTwoStart = sessionContext.getHistory().length;
    sessionContext.addMessage({
      role: 'tool',
      tool_call_id: 'ask-1',
      content: '{"answer":"确认"}',
    });
    await plugin.hooks[HookEventName.RunStart](
      hookContext(sessionContext, HookEventName.RunStart),
      next,
    );
    sessionContext.addMessage({ role: 'assistant', content: '继续处理', tool_calls: [{
      id: 'ask-2',
      type: 'function',
      function: { name: 'ask_user_question', arguments: '{}' },
    }] });
    await runHookPipeline(
      HookEventName.RunEnd,
      sessionContext,
      [plugin.hooks[HookEventName.RunEnd]],
      {
        runSummary: {
          ...completedSummary(1, segmentTwoStart, sessionContext.getHistory().length),
          terminalStatus: 'waiting_for_interaction',
          hasFinalResponse: false,
          waitingForInteraction: true,
        },
      },
    );
    expect(sessionContext.getSkillLearningContinuation()).toMatchObject({
      segmentCount: 2,
    });

    // 第三段：恢复并完成。恢复边界同样取第二段 RunEnd 时的历史长度。
    const segmentThreeStart = sessionContext.getHistory().length;
    sessionContext.addMessage({
      role: 'tool',
      tool_call_id: 'ask-2',
      content: '{"answer":"再确认"}',
    });
    await plugin.hooks[HookEventName.RunStart](
      hookContext(sessionContext, HookEventName.RunStart),
      next,
    );
    sessionContext.addMessage({ role: 'assistant', content: '任务完成' });
    await plugin.hooks[HookEventName.RunEnd](
      hookContext(sessionContext, HookEventName.RunEnd, {
        runSummary: completedSummary(1, segmentThreeStart, sessionContext.getHistory().length),
      }),
      next,
    );

    expect(scheduler.schedule).toHaveBeenCalledTimes(1);
    const trajectory = scheduled[0].trajectory;
    // 三段消息按顺序各出现一次：用户任务、两轮交互问答与最终回答。
    expect(trajectory).toEqual([
      { role: 'user', content: '第一段用户任务' },
      { role: 'assistant', content: '需要确认', tool_calls: [{
        id: 'ask-1',
        type: 'function',
        function: { name: 'ask_user_question', arguments: '{}' },
      }] },
      { role: 'tool', tool_call_id: 'ask-1', content: '{"answer":"确认"}' },
      { role: 'assistant', content: '继续处理', tool_calls: [{
        id: 'ask-2',
        type: 'function',
        function: { name: 'ask_user_question', arguments: '{}' },
      }] },
      { role: 'tool', tool_call_id: 'ask-2', content: '{"answer":"再确认"}' },
      { role: 'assistant', content: '任务完成' },
    ]);
  });

  it('前台 skill_manage 成功或暂存时本任务不推进累计，失败照常累计', async () => {
    const plugin = new SkillLearningPlugin({
      backgroundReviewEnabled: true,
      creationNudgeInterval: 3,
    }, scheduler);
    const next = vi.fn().mockResolvedValue(undefined);
    sessionContext.addMessage({ role: 'user', content: '任务' });
    const start = 1;

    // 前台 skill_manage 返回 success：本任务已沉淀，不推进累计。
    await plugin.hooks[HookEventName.RunStart](
      hookContext(sessionContext, HookEventName.RunStart),
      next,
    );
    sessionContext.addMessage({ role: 'assistant', content: '完成' });
    await plugin.hooks[HookEventName.AfterTool](
      hookContext(sessionContext, HookEventName.AfterTool, {
        toolCall: {
          id: 'sm-1',
          name: 'skill_manage',
          arguments: { action: 'edit', name: 'demo' },
        },
        toolResult: {
          content: JSON.stringify({ status: 'success', action: 'edit', name: 'demo' }),
          isError: false,
        },
      }),
      next,
    );
    await plugin.hooks[HookEventName.RunEnd](
      hookContext(sessionContext, HookEventName.RunEnd, {
        runSummary: completedSummary(2, start, sessionContext.getHistory().length),
      }),
      next,
    );
    expect(scheduler.schedule).not.toHaveBeenCalled();

    // 前台 skill_manage 返回 error：不豁免，照常累计。
    sessionContext.addMessage({ role: 'user', content: '第二个任务' });
    const secondStart = sessionContext.getHistory().length;
    await plugin.hooks[HookEventName.RunStart](
      hookContext(sessionContext, HookEventName.RunStart),
      next,
    );
    sessionContext.addMessage({ role: 'assistant', content: '完成' });
    await plugin.hooks[HookEventName.AfterTool](
      hookContext(sessionContext, HookEventName.AfterTool, {
        toolCall: {
          id: 'sm-2',
          name: 'skill_manage',
          arguments: { action: 'edit', name: 'demo' },
        },
        toolResult: {
          content: JSON.stringify({ status: 'error', action: 'edit', name: 'demo' }),
          isError: false,
        },
      }),
      next,
    );
    await plugin.hooks[HookEventName.RunEnd](
      hookContext(sessionContext, HookEventName.RunEnd, {
        runSummary: completedSummary(1, secondStart, sessionContext.getHistory().length),
      }),
      next,
    );
    // 第一个任务 0 + 第二个任务 1 = 1 < 阈值 3，仍未调度。
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });

  it('调度同步拒绝时保持累计值，接受后只减一个阈值并保留余数', async () => {
    let acceptNext = false;
    const plugin = new SkillLearningPlugin({
      backgroundReviewEnabled: true,
      creationNudgeInterval: 3,
    }, {
      schedule: () => {
        const accepted = acceptNext;
        acceptNext = true;
        return { accepted, taskId: accepted ? 'task-1' : null };
      },
    });
    const next = vi.fn().mockResolvedValue(undefined);

    // 第一次达阈值但调度拒绝：累计保持 3。
    await plugin.hooks[HookEventName.RunStart](
      hookContext(sessionContext, HookEventName.RunStart),
      next,
    );
    await plugin.hooks[HookEventName.RunEnd](
      hookContext(sessionContext, HookEventName.RunEnd, {
        runSummary: completedSummary(3),
      }),
      next,
    );
    expect(sessionContext.getSkillLearningCadence()).toMatchObject({
      accumulatedToolResponseIterations: 3,
    });

    // 第二次达阈值且接受：减一个阈值，保留余数。
    await plugin.hooks[HookEventName.RunStart](
      hookContext(sessionContext, HookEventName.RunStart),
      next,
    );
    await plugin.hooks[HookEventName.RunEnd](
      hookContext(sessionContext, HookEventName.RunEnd, {
        runSummary: completedSummary(5),
      }),
      next,
    );
    expect(sessionContext.getSkillLearningCadence()).toMatchObject({
      accumulatedToolResponseIterations: 5,
    });
  });

  it('跨重启从会话快照恢复累计值继续累计', async () => {
    // 模拟旧进程快照中已累计 7 次。
    sessionContext.setSkillLearningCadence({
      version: 1,
      accumulatedToolResponseIterations: 7,
    });
    const plugin = new SkillLearningPlugin({
      backgroundReviewEnabled: true,
      creationNudgeInterval: 10,
    }, scheduler);
    const next = vi.fn().mockResolvedValue(undefined);

    await plugin.hooks[HookEventName.RunStart](
      hookContext(sessionContext, HookEventName.RunStart),
      next,
    );
    await plugin.hooks[HookEventName.RunEnd](
      hookContext(sessionContext, HookEventName.RunEnd, {
        runSummary: completedSummary(3),
      }),
      next,
    );

    // 7 + 3 = 10 达到阈值：调度并归零（余数 0）。
    expect(scheduler.schedule).toHaveBeenCalledTimes(1);
    expect(sessionContext.getSkillLearningCadence()).toMatchObject({
      accumulatedToolResponseIterations: 0,
    });
  });

  it('前台沉淀标志跨等待恢复，等待前后均不重复推进累计', async () => {
    const plugin = new SkillLearningPlugin({
      backgroundReviewEnabled: true,
      creationNudgeInterval: 10,
    }, scheduler);
    const next = vi.fn().mockResolvedValue(undefined);

    // 第一段：前台 skill_manage 成功后等待交互。
    sessionContext.addMessage({ role: 'user', content: '沉淀任务' });
    const firstStart = sessionContext.getHistory().length;
    await plugin.hooks[HookEventName.RunStart](
      hookContext(sessionContext, HookEventName.RunStart),
      next,
    );
    await plugin.hooks[HookEventName.AfterTool](
      hookContext(sessionContext, HookEventName.AfterTool, {
        toolCall: { id: 'sm-wait', name: 'skill_manage', arguments: {} },
        toolResult: {
          content: JSON.stringify({ status: 'staged', action: 'create', name: 'x' }),
          isError: false,
        },
      }),
      next,
    );
    sessionContext.addMessage({ role: 'assistant', content: '等待确认', tool_calls: [{
      id: 'ask-wait',
      type: 'function',
      function: { name: 'ask_user_question', arguments: '{}' },
    }] });
    await plugin.hooks[HookEventName.RunEnd](
      hookContext(sessionContext, HookEventName.RunEnd, {
        runSummary: {
          ...completedSummary(2, firstStart, sessionContext.getHistory().length),
          terminalStatus: 'waiting_for_interaction',
          hasFinalResponse: false,
          waitingForInteraction: true,
        },
      }),
      next,
    );
    expect(sessionContext.getSkillLearningContinuation()).toMatchObject({
      foregroundSkillMutationHandled: true,
    });

    // 第二段：恢复完成，等待前后的工具型响应均不推进累计。
    const secondStart = sessionContext.getHistory().length;
    sessionContext.addMessage({
      role: 'tool',
      tool_call_id: 'ask-wait',
      content: '{"answer":"确认"}',
    });
    await plugin.hooks[HookEventName.RunStart](
      hookContext(sessionContext, HookEventName.RunStart),
      next,
    );
    sessionContext.addMessage({ role: 'assistant', content: '完成' });
    await plugin.hooks[HookEventName.RunEnd](
      hookContext(sessionContext, HookEventName.RunEnd, {
        runSummary: completedSummary(2, secondStart, sessionContext.getHistory().length),
      }),
      next,
    );

    // 累计为 0：不调度、不推进（前后两段合计 4 次工具响应均被豁免）。
    expect(scheduler.schedule).not.toHaveBeenCalled();
    expect(sessionContext.getSkillLearningCadence()).toMatchObject({
      accumulatedToolResponseIterations: 0,
    });
  });

  it('真实 CallToolResult 包络中的前台沉淀会跳过复盘且不消费历史阈值', async () => {
    sessionContext.setSkillLearningCadence({
      version: 1,
      accumulatedToolResponseIterations: 10,
    });
    const plugin = new SkillLearningPlugin({
      backgroundReviewEnabled: true,
      creationNudgeInterval: 10,
    }, scheduler);
    const next = vi.fn().mockResolvedValue(undefined);

    await plugin.hooks[HookEventName.RunStart](
      hookContext(sessionContext, HookEventName.RunStart),
      next,
    );
    await plugin.hooks[HookEventName.AfterTool](
      hookContext(sessionContext, HookEventName.AfterTool, {
        toolCall: { id: 'sm-envelope', name: 'skill_manage', arguments: {} },
        toolResult: {
          // ToolCallOrchestrator 交给 AfterTool 的真实结构是序列化后的 CallToolResult。
          content: JSON.stringify({
            content: [{
              type: 'text',
              text: JSON.stringify({ status: 'success', action: 'edit', name: 'x' }),
            }],
          }),
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

    expect(scheduler.schedule).not.toHaveBeenCalled();
    expect(sessionContext.getSkillLearningCadence()).toMatchObject({
      accumulatedToolResponseIterations: 10,
    });
  });

  it('等待前的延续状态缺少前台沉淀标志时按 false 迁移', async () => {
    // 手工构造 version 1 旧延续状态（无 foregroundSkillMutationHandled 字段）。
    sessionContext.setSkillLearningContinuation({
      version: 1 as unknown as 2,
      trajectory: [{ role: 'user', content: '旧任务' }],
      loadedSkills: [],
      toolEvidence: [],
      toolIterationCount: 1,
      requestedToolCallCount: 1,
      segmentCount: 1,
      // 恢复边界为 0，与恢复 run 的学习起点一致。
      resumeHistoryIndex: 0,
    } as unknown as import('../../../../src/core/domain/skill-learning-continuation.js').SkillLearningContinuation);

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
        runSummary: completedSummary(1, 0, 0),
      }),
      next,
    );

    // 旧状态按未沉淀迁移：本任务照常累计并调度。
    expect(scheduler.schedule).toHaveBeenCalledTimes(1);
  });
});
