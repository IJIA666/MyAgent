/**
 * @file 纯文字平台发帖任务的 Skill 学习闭环集成测试。
 * 使用假 LLM 与真实 ToolRegistry，不访问真实平台或网络。
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../../src/adapters/tools/toolRegistry.js';
import { LoadSkillTool } from '../../src/adapters/tools/impl/skill/skill.js';
import { createApplicationPaths } from '../../src/config/application-paths.js';
import type { LlmConfig } from '../../src/config/index.js';
import type {
  LlmPort,
  LlmStreamEvent,
} from '../../src/ports/driven/llm/LlmPort.js';
import type { TokenEstimatorPort } from '../../src/ports/driven/llm/TokenEstimatorPort.js';
import { SessionContext } from '../../src/core/domain/context.js';
import { PermissionSessionState } from '../../src/core/domain/permissions/permission-session-state.js';
import { createTrustedCallContext } from '../../src/core/domain/permissions/trusted-call-context.js';
import { BackgroundSkillReviewService } from '../../src/core/usecases/brain/background-skill-review.js';
import { SkillLibrary } from '../../src/core/usecases/brain/skill-library.js';
import {
  SkillPendingStore,
  SkillWriteApprovalController,
} from '../../src/core/usecases/brain/skill-pending-store.js';
import {
  SKILL_PENDING_APPROVAL_CALLER_PREFIX,
} from '../../src/core/usecases/brain/skill-types.js';
import { SkillUsageStore } from '../../src/core/usecases/brain/skill-usage-store.js';
import { ContextRepository } from '../../src/core/usecases/brain/ContextRepository.js';
import {
  SkillLearningPlugin,
  type BackgroundSkillReviewRequest,
  type BackgroundSkillReviewScheduler,
} from '../../src/core/usecases/plugins/SkillLearningPlugin.js';
import {
  HookEventName,
  type AgentRunSummary,
  type HookContext,
} from '../../src/core/usecases/plugins/plugin-types.js';
import { createMockAppConfig } from '../helpers/mock-factory.js';

const createdRoots: string[] = [];

afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('Skill learning loop integration', () => {
  it('累计 10 次模型循环后先交付主回复，再后台创建 class-level Skill 并供下一会话加载', async () => {
    let releaseModel!: () => void;
    const modelGate = new Promise<void>(resolve => {
      releaseModel = resolve;
    });
    const harness = createHarness({
      writeApproval: false,
      driver: createReviewDriver({ gate: modelGate, createSkill: true }),
    });
    const scheduled = createTrackedScheduler(harness.reviewService);
    const plugin = new SkillLearningPlugin(harness.appConfig.skills, scheduled);
    const mainContext = new SessionContext('main-text-posting');
    const next = vi.fn().mockResolvedValue(undefined);

    await completeMainRun(plugin, mainContext, next, 4, true);
    expect(scheduled.reviewPromise).toBeUndefined();
    await completeMainRun(plugin, mainContext, next, 6, true);

    expect(mainContext.getHistory().at(-1)).toMatchObject({
      role: 'assistant',
      content: '纯文字帖子已准备完成',
    });
    expect(scheduled.reviewPromise).toBeDefined();
    expect(harness.library.get('plain-text-social-posting')).toBeUndefined();

    // 多任务累计达到阈值时，隔离 Review 快照包含完整当前会话：
    // 两次任务贡献计数的用户消息与最终回复都保留，且父 system 不进入快照。
    const snapshot = scheduled.request?.conversationHistory ?? [];
    expect(snapshot.filter(message => (
      message.content === '为纯文字平台帖子整理标题、正文和发布前检查'
    ))).toHaveLength(2);
    expect(snapshot.filter(message => message.content === '纯文字帖子已准备完成')).toHaveLength(2);
    expect(snapshot.some(message => message.role === 'system')).toBe(false);

    releaseModel();
    const review = await scheduled.reviewPromise;
    expect(review?.mutations).toMatchObject([{
      status: 'success',
      action: 'create',
      name: 'plain-text-social-posting',
    }]);

    const nextSessionLibrary = new SkillLibrary(
      harness.paths.userSkillsDir,
      harness.paths.projectSkillsDir,
      harness.paths.skillArchiveDir,
      new SkillUsageStore(harness.paths.skillUsagePath),
      { enableWatcher: false },
    );
    expect(nextSessionLibrary.list().map(skill => skill.name))
      .toContain('plain-text-social-posting');
    // load_skill 返回结构化 JSON，正文在 content 字段中。
    const loaded = JSON.parse(await new LoadSkillTool(nextSessionLibrary).execute({
      name: 'plain-text-social-posting',
    })) as { content: string };
    expect(loaded.content).toContain('发布前校验');
    await harness.registry.close();
  });

  it('writeApproval=true 时后台只产生 pending，受信批准后下一会话才可加载', async () => {
    const harness = createHarness({
      writeApproval: true,
      driver: createReviewDriver({ createSkill: true }),
    });
    const scheduled = createTrackedScheduler(harness.reviewService);
    const plugin = new SkillLearningPlugin(harness.appConfig.skills, scheduled);
    const mainContext = new SessionContext('main-pending-posting');
    const next = vi.fn().mockResolvedValue(undefined);

    await completeMainRun(plugin, mainContext, next, 10, true);
    const review = await scheduled.reviewPromise;

    expect(review?.mutations).toMatchObject([{
      status: 'staged',
      action: 'create',
      name: 'plain-text-social-posting',
    }]);
    expect(harness.library.get('plain-text-social-posting')).toBeUndefined();
    const pending = harness.pendingStore.list();
    expect(pending).toHaveLength(1);

    const approvalContext = new SessionContext('skill-approval-session');
    approvalContext.appConfig = harness.appConfig;
    const outcome = await harness.registry.callTool(
      'skill_manage',
      { ...pending[0].request },
      approvalContext,
      undefined,
      undefined,
      `approve-${pending[0].id}`,
      30_000,
      {
        securityContext: {
          caller: createTrustedCallContext(
            `${SKILL_PENDING_APPROVAL_CALLER_PREFIX}:${pending[0].id}`,
            'interactive',
          ),
          permissionState: approvalContext.getPermissionSessionState(),
          approvalAllowed: true,
          auditSource: 'skill_learning_integration_approval',
        },
      },
    );

    expect(parseToolPayload(outcome.value)).toMatchObject({ status: 'success' });
    expect(harness.pendingStore.list()).toEqual([]);
    const nextSessionLibrary = new SkillLibrary(
      harness.paths.userSkillsDir,
      harness.paths.projectSkillsDir,
      harness.paths.skillArchiveDir,
      new SkillUsageStore(harness.paths.skillUsagePath),
      { enableWatcher: false },
    );
    const loaded = JSON.parse(await new LoadSkillTool(nextSessionLibrary).execute({
      name: 'plain-text-social-posting',
    })) as { content: string };
    expect(loaded.content).toContain('纯文字平台');
    await harness.registry.close();
  });

  it('达到阈值但没有可复用学习证据时 Review 合法 no-op，不创建 Skill', async () => {
    const harness = createHarness({
      writeApproval: false,
      driver: createReviewDriver({ createSkill: false }),
    });
    const scheduled = createTrackedScheduler(harness.reviewService);
    const plugin = new SkillLearningPlugin(harness.appConfig.skills, scheduled);
    const mainContext = new SessionContext('main-no-learning-evidence');
    const next = vi.fn().mockResolvedValue(undefined);

    await completeMainRun(plugin, mainContext, next, 10, false);
    const review = await scheduled.reviewPromise;

    expect(review?.mutations).toEqual([]);
    expect(harness.library.list()).toEqual([]);
    expect(harness.pendingStore.list()).toEqual([]);
    await harness.registry.close();
  });

  it('等待交互前的学习证据在会话恢复后仍参与最终 Review', async () => {
    const harness = createHarness({
      writeApproval: false,
      driver: createReviewDriver({ createSkill: true }),
    });
    const scheduled = createTrackedScheduler(harness.reviewService);
    const waitingPlugin = new SkillLearningPlugin(harness.appConfig.skills, scheduled);
    const waitingContext = new SessionContext('main-waiting-posting');
    const next = vi.fn().mockResolvedValue(undefined);
    const waitingStart = waitingContext.getHistory().length;

    await waitingPlugin.hooks[HookEventName.RunStart](
      hookContext(waitingContext, HookEventName.RunStart),
      next,
    );
    waitingContext.addMessage({ role: 'user', content: '探索纯文字平台的真实发布流程' });
    waitingContext.addMessage({
      role: 'assistant',
      content: '发布前需要用户完成账号验证',
      tool_calls: [{
        id: 'ask-account-verification',
        type: 'function',
        function: {
          name: 'ask_user_question',
          arguments: '{"questions":[]}',
        },
      }],
    });
    await waitingPlugin.hooks[HookEventName.RunEnd](
      hookContext(waitingContext, HookEventName.RunEnd, {
        runSummary: {
          terminalStatus: 'waiting_for_interaction',
          modelLoopCount: 9,
          toolIterationCount: 1,
          requestedToolCallCount: 1,
          physicalRunStartIndex: waitingStart,
          learningTrajectoryStartIndex: waitingStart,
          historyEndIndex: waitingContext.getHistory().length,
          hasFinalResponse: false,
          waitingForInteraction: true,
        },
      }),
      next,
    );
    expect(scheduled.reviewPromise).toBeUndefined();

    const waitingRepo = new ContextRepository(
      waitingContext,
      harness.paths.sessionsDir,
    );
    await waitingRepo.saveState();

    // 模拟进程重启：使用新的 SessionContext、ContextRepository 和插件实例恢复。
    const resumedContext = new SessionContext('main-waiting-posting-reloaded');
    await new ContextRepository(resumedContext, harness.paths.sessionsDir)
      .loadState(waitingContext.getSessionId());
    resumedContext.addMessage({
      role: 'tool',
      tool_call_id: 'ask-account-verification',
      content: '{"continue":"验证完成"}',
    });
    const resumedPlugin = new SkillLearningPlugin(harness.appConfig.skills, scheduled);
    // 恢复 run 的学习起点必须等于延续状态的恢复边界。
    const resumeIndex = resumedContext.getSkillLearningContinuation()?.resumeHistoryIndex;
    await completeMainRun(resumedPlugin, resumedContext, next, 1, true, resumeIndex);

    // 等待恢复契约：快照从恢复后的主会话当前历史一次性取得，
    // 最初任务、交互工具回答与恢复后回复按发生顺序各出现一次，不重复拼接。
    const snapshot = scheduled.request?.conversationHistory ?? [];
    expect(snapshot.filter(message => message.content === '探索纯文字平台的真实发布流程'))
      .toHaveLength(1);
    expect(snapshot.filter(message => message.tool_call_id === 'ask-account-verification'))
      .toHaveLength(1);
    expect(snapshot.filter(message => message.content === '纯文字帖子已准备完成'))
      .toHaveLength(1);
    expect(new Set(snapshot.map(message => JSON.stringify(message))).size)
      .toBe(snapshot.length);

    const review = await scheduled.reviewPromise;
    expect(review?.mutations).toMatchObject([{
      status: 'success',
      action: 'create',
      name: 'plain-text-social-posting',
    }]);
    await harness.registry.close();
  });
});

/** 创建真实 Skill 存储、工具网关与隔离 Review 服务。 */
function createHarness(options: {
  readonly writeApproval: boolean;
  readonly driver: LlmPort;
}) {
  const root = mkdtempSync(join(tmpdir(), 'skill-learning-loop-'));
  createdRoots.push(root);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const paths = createApplicationPaths(workspace, {
    appDataRoot: join(root, 'app-data'),
  });
  const appConfig = createMockAppConfig({
    workspace,
    applicationPaths: paths,
    skills: {
      backgroundReviewEnabled: true,
      creationNudgeInterval: 10,
      writeApproval: options.writeApproval,
    },
    diagnostics: {
      operationalEnabled: false,
      auditEnabled: false,
      replayEnabled: false,
      customPatterns: [],
      traceRetentionDays: 1,
      traceRetentionSessions: 1,
      auditRetentionDays: 1,
      auditRetentionSessions: 1,
    },
  });
  const usageStore = new SkillUsageStore(paths.skillUsagePath);
  const library = new SkillLibrary(
    paths.userSkillsDir,
    paths.projectSkillsDir,
    paths.skillArchiveDir,
    usageStore,
    { enableWatcher: false },
  );
  const pendingStore = new SkillPendingStore(paths.skillPendingDir, library);
  const approvalController = new SkillWriteApprovalController(options.writeApproval);
  const registry = new ToolRegistry(undefined, {
    skillLibrary: library,
    skillPendingStore: pendingStore,
    skillWriteApprovalController: approvalController,
  });
  const parentPermissionState = new PermissionSessionState();
  const reviewService = new BackgroundSkillReviewService({
    toolRegistry: registry,
    driver: options.driver,
    llmConfigProvider: () => appConfig.llm as LlmConfig,
    estimator: createEstimator(),
    contextAdapter: {
      assemble: history => structuredClone(history),
    },
    appConfig,
    skillLibrary: library,
    parentPermissionStateProvider: () => parentPermissionState,
    parentCallerProvider: () => createTrustedCallContext('main-session', 'interactive'),
  });
  return {
    appConfig,
    paths,
    library,
    pendingStore,
    registry,
    reviewService,
  };
}

/** 创建可观测但不阻塞 SkillLearningPlugin 的后台调度器。 */
function createTrackedScheduler(service: BackgroundSkillReviewService): {
  readonly schedule: BackgroundSkillReviewScheduler['schedule'];
  reviewPromise?: ReturnType<BackgroundSkillReviewService['runReview']>;
  request?: Readonly<BackgroundSkillReviewRequest>;
} {
  const scheduler: {
    schedule: BackgroundSkillReviewScheduler['schedule'];
    reviewPromise?: ReturnType<BackgroundSkillReviewService['runReview']>;
    request?: Readonly<BackgroundSkillReviewRequest>;
  } = {
    schedule(request: Readonly<BackgroundSkillReviewRequest>) {
      // 记录原请求供快照内容断言；后台任务仍按真实链路异步执行。
      scheduler.request = request;
      scheduler.reviewPromise = service.runReview(request);
      return { accepted: true, taskId: 'test-tracked' };
    },
  };
  return scheduler;
}

/**
 * 模拟一个已交付最终回复的成功主 run，并可附带结构化工具证据。
 *
 * @param modelLoopCount - 当前成功主 run 的模型循环数
 * @param learningTrajectoryStartIndex - 可选的学习轨迹起点；
 * 恢复 run 必须显式传入延续状态的 resumeHistoryIndex，普通任务缺省取当前历史长度
 */
async function completeMainRun(
  plugin: SkillLearningPlugin,
  context: SessionContext,
  next: () => Promise<void>,
  modelLoopCount: number,
  withEvidence: boolean,
  learningTrajectoryStartIndex?: number,
): Promise<void> {
  const start = learningTrajectoryStartIndex ?? context.getHistory().length;
  await plugin.hooks[HookEventName.RunStart](
    hookContext(context, HookEventName.RunStart),
    next,
  );
  context.addMessage({
    role: 'user',
    content: '为纯文字平台帖子整理标题、正文和发布前检查',
  });
  if (withEvidence) {
    await plugin.hooks[HookEventName.AfterTool](
      hookContext(context, HookEventName.AfterTool, {
        toolCall: {
          id: `validation-${modelLoopCount}`,
          name: 'validate_post',
          arguments: { format: 'plain-text' },
        },
        toolResult: {
          content: '标题非空、正文长度合规、未包含图片依赖，校验成功',
          isError: false,
        },
      }),
      next,
    );
  }
  context.addMessage({
    role: 'assistant',
    content: '纯文字帖子已准备完成',
  });
  const summary: AgentRunSummary = {
    terminalStatus: 'completed',
    modelLoopCount,
    // 该辅助链路每个有证据的 run 只模拟一次工具型响应，阈值只由模型循环驱动。
    toolIterationCount: withEvidence ? 1 : 0,
    requestedToolCallCount: withEvidence ? 1 : 0,
    physicalRunStartIndex: context.getHistory().length,
    learningTrajectoryStartIndex: start,
    historyEndIndex: context.getHistory().length,
    hasFinalResponse: true,
    waitingForInteraction: false,
  };
  await plugin.hooks[HookEventName.RunEnd](
    hookContext(context, HookEventName.RunEnd, { runSummary: summary }),
    next,
  );
}

/** 创建只会选择 create 或合法 no-op 的确定性假 LLM。 */
function createReviewDriver(options: {
  readonly createSkill: boolean;
  readonly gate?: Promise<void>;
}): LlmPort {
  let modelCalls = 0;
  return {
    getModelName: () => 'fake-skill-review',
    switchModel: () => undefined,
    abort: () => undefined,
    streamChat: async function* (): AsyncGenerator<LlmStreamEvent, void, unknown> {
      modelCalls++;
      if (!options.createSkill) {
        yield {
          type: 'complete',
          content: 'Nothing to save',
          reasoning: '',
          assistantMessage: { role: 'assistant', content: 'Nothing to save' },
        };
        return;
      }
      if (modelCalls === 1) {
        await options.gate;
        const toolCall = {
          id: 'create-text-posting-skill',
          type: 'function' as const,
          function: {
            name: 'skill_manage',
            arguments: JSON.stringify({
              action: 'create',
              name: 'plain-text-social-posting',
              content: [
                '---',
                'name: plain-text-social-posting',
                'description: 可复用的纯文字平台发帖准备与校验方法',
                '---',
                '',
                '# 纯文字平台发帖',
                '',
                '1. 明确受众、标题和单一主题。',
                '2. 组织正文并保留自然段。',
                '3. 发布前校验标题非空、正文长度和平台限制。',
                '4. 发布后检查返回状态，确认内容真实可见。',
              ].join('\n'),
            }),
          },
        };
        yield {
          type: 'tool_calls',
          toolCalls: [toolCall],
          assistantMessage: {
            role: 'assistant',
            content: '保存跨平台可复用的纯文字发帖方法',
            tool_calls: [toolCall],
          },
        };
        return;
      }
      yield {
        type: 'complete',
        content: 'Review complete',
        reasoning: '',
        assistantMessage: { role: 'assistant', content: 'Review complete' },
      };
    },
    chat: async () => '',
    generateSummaryAsync: async () => '',
  };
}

/** 构造不会触发压缩的确定性 token 估算器。 */
function createEstimator(): TokenEstimatorPort {
  const usage = (outputReserve = 0) => ({
    total: 20 + outputReserve,
    inputTotal: 20,
    system: 5,
    rules: 0,
    transient: 0,
    history: 15,
    tools: 0,
    outputReserve,
    isEstimated: true,
  });
  return {
    countTokens: value => value.length,
    estimateMessageTokens: message => message.content?.length ?? 0,
    estimateSnapshotTokens: () => usage(),
    estimateRequestTokens: (_messages, _tools, outputReserve) => usage(outputReserve),
    getCompactionThreshold: () => 100_000,
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

/** 从 ToolRegistry 返回值的首个文本块解析 JSON。 */
function parseToolPayload(value: unknown): Record<string, unknown> {
  const text = (value as { content?: Array<{ text?: string }> })
    .content?.[0]?.text;
  if (!text) {
    throw new Error('skill_manage 未返回文本 JSON');
  }
  return JSON.parse(text) as Record<string, unknown>;
}
