/**
 * @file BackgroundSkillReviewService 的隔离 Agent、prompt、结果门槛与取消测试。
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApplicationPaths } from '../../../../src/config/application-paths.js';
import type { LlmConfig } from '../../../../src/config/index.js';
import type {
  ChatMessage,
  LlmPort,
  LlmStreamEvent,
} from '../../../../src/ports/driven/llm/LlmPort.js';
import type { TokenEstimatorPort } from '../../../../src/ports/driven/llm/TokenEstimatorPort.js';
import type { ContextAdapter } from '../../../../src/ports/driven/session/ContextAdapter.js';
import type { ToolRegistryPort } from '../../../../src/ports/driven/tools/ToolRegistryPort.js';
import { PermissionSessionState } from '../../../../src/core/domain/permissions/permission-session-state.js';
import { createTrustedCallContext } from '../../../../src/core/domain/permissions/trusted-call-context.js';
import {
  BACKGROUND_SKILL_REVIEW_PROMPT,
  BackgroundSkillReviewService,
  buildBackgroundReviewInput,
} from '../../../../src/core/usecases/brain/background-skill-review.js';
import { SkillLibrary } from '../../../../src/core/usecases/brain/skill-library.js';
import { SkillUsageStore } from '../../../../src/core/usecases/brain/skill-usage-store.js';
import type { BackgroundSkillReviewRequest } from '../../../../src/core/usecases/plugins/SkillLearningPlugin.js';
import { createMockAppConfig } from '../../../helpers/mock-factory.js';

const tempDirs: string[] = [];

/** 创建完整但确定性的 Token 估算器。 */
function createEstimator(): TokenEstimatorPort {
  const usage = {
    total: 10,
    inputTotal: 10,
    system: 2,
    rules: 0,
    transient: 0,
    history: 8,
    tools: 0,
    outputReserve: 0,
    isEstimated: true,
  };
  return {
    countTokens: value => value.length,
    estimateMessageTokens: message => message.content?.length ?? 0,
    estimateSnapshotTokens: () => ({ ...usage }),
    estimateRequestTokens: (_messages, _tools, outputReserve) => ({
      ...usage,
      total: usage.total + outputReserve,
      outputReserve,
    }),
    getCompactionThreshold: () => 100_000,
  };
}

/** 创建测试 Review 输入。 */
function createReviewRequest(): BackgroundSkillReviewRequest {
  return {
    trajectory: [
      { role: 'user', content: '发布一条纯文字帖子' },
      { role: 'assistant', content: '先检查登录状态' },
      { role: 'tool', tool_call_id: 'check-1', content: 'logged-in' },
      { role: 'assistant', content: '发布成功' },
    ],
    loadedSkills: ['text-posting'],
    toolEvidence: [{
      toolCallId: 'check-1',
      toolName: 'browser_state',
      status: 'success',
      resultSummary: 'logged-in',
    }],
    runSummary: {
      terminalStatus: 'completed',
      toolIterationCount: 1,
      requestedToolCallCount: 1,
      historyStartIndex: 0,
      historyEndIndex: 4,
      hasFinalResponse: true,
      waitingForInteraction: false,
    },
  };
}

/** 创建隔离路径、SkillLibrary 与 AppConfig。 */
function createEnvironment() {
  const root = mkdtempSync(join(tmpdir(), 'background-skill-review-'));
  tempDirs.push(root);
  const workspace = join(root, 'workspace');
  const appDataRoot = join(root, 'app-data');
  mkdirSync(workspace, { recursive: true });
  const paths = createApplicationPaths(workspace, { appDataRoot });
  const appConfig = createMockAppConfig({
    workspace,
    applicationPaths: paths,
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
  const skillLibrary = new SkillLibrary(
    paths.userSkillsDir,
    paths.projectSkillsDir,
    paths.skillArchiveDir,
    usageStore,
    { enableWatcher: false },
  );
  return { root, paths, appConfig, skillLibrary };
}

/** 创建具备两个 Skill 工具定义的父 ToolRegistry mock。 */
function createParentRegistry() {
  return {
    getTools: vi.fn().mockResolvedValue([
      {
        type: 'function',
        function: { name: 'load_skill', parameters: { type: 'object' } },
        securityCategory: 'read',
      },
      {
        type: 'function',
        function: { name: 'skill_manage', parameters: { type: 'object' } },
        securityCategory: 'write',
      },
      {
        type: 'function',
        function: { name: 'readFile', parameters: { type: 'object' } },
        securityCategory: 'read',
      },
    ]),
    getTool: vi.fn((name: string) => ({
      name,
      securityCategory: name === 'skill_manage' ? 'write' as const : 'read' as const,
    })),
    callTool: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

/** 装配可直接运行的 BackgroundSkillReviewService。 */
function createService(
  driver: LlmPort,
  registry: ReturnType<typeof createParentRegistry>,
  notify = vi.fn(),
) {
  const environment = createEnvironment();
  const permissionState = new PermissionSessionState();
  const contextAdapter: ContextAdapter = {
    assemble: (history: ChatMessage[]) => structuredClone(history),
  };
  const service = new BackgroundSkillReviewService({
    toolRegistry: registry as unknown as ToolRegistryPort,
    driver,
    llmConfigProvider: () => environment.appConfig.llm as LlmConfig,
    estimator: createEstimator(),
    contextAdapter,
    appConfig: environment.appConfig,
    skillLibrary: environment.skillLibrary,
    parentPermissionStateProvider: () => permissionState,
    parentCallerProvider: () => createTrustedCallContext('parent-session'),
    notify,
  });
  return { service, notify, ...environment };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('BackgroundSkillReviewService', () => {
  it('固定 prompt 应包含复用、跨实例、验证和正向路径准则且允许 no-op', () => {
    expect(BACKGROUND_SKILL_REVIEW_PROMPT).toContain('class-level umbrella');
    expect(BACKGROUND_SKILL_REVIEW_PROMPT).toContain('跨实例性');
    expect(BACKGROUND_SKILL_REVIEW_PROMPT).toContain('验证性');
    expect(BACKGROUND_SKILL_REVIEW_PROMPT).toContain('正向路径优先');
    expect(BACKGROUND_SKILL_REVIEW_PROMPT).toContain('Nothing to save');
    expect(BACKGROUND_SKILL_REVIEW_PROMPT).not.toContain('至少');
    expect(BACKGROUND_SKILL_REVIEW_PROMPT).toContain('未经验证的断言');
  });

  it('有界输入只携带本次轨迹、已加载 Skill 和结构化证据', () => {
    const baseRequest = createReviewRequest();
    const request: BackgroundSkillReviewRequest = {
      ...baseRequest,
      trajectory: [
        { role: 'system', content: '父会话私密系统配置' },
        ...baseRequest.trajectory,
        { role: 'tool', tool_call_id: 'large', content: 'x'.repeat(7_000) },
      ],
    };
    const input = buildBackgroundReviewInput(request);

    expect(input).not.toContain('父会话私密系统配置');
    expect(input).toContain('"loadedSkills"');
    expect(input).toContain('text-posting');
    expect(input).toContain('"toolEvidence"');
    expect(input).toContain('[truncated');
  });

  it('Nothing to save 是正常 no-op，模型文本声称保存也不得通知', async () => {
    const receivedTools: unknown[][] = [];
    const driver = {
      getModelName: () => 'mock-model',
      switchModel: () => {},
      streamChat: vi.fn().mockImplementation(async function* (
        _messages: ChatMessage[],
        tools: unknown[],
      ) {
        receivedTools.push(tools);
        yield {
          type: 'complete',
          content: '已保存到知识库。Nothing to save',
          reasoning: '',
          assistantMessage: { role: 'assistant', content: '已保存到知识库。Nothing to save' },
        } as LlmStreamEvent;
      }),
    } as unknown as LlmPort;
    const registry = createParentRegistry();
    const { service, notify } = createService(driver, registry);

    const result = await service.runReview(createReviewRequest());

    expect(result).toMatchObject({ cancelled: false, mutations: [] });
    expect(notify).not.toHaveBeenCalled();
    expect(registry.callTool).not.toHaveBeenCalled();
    expect(receivedTools[0]).toHaveLength(2);
  });

  it.each([
    ['success', '{"status":"success","action":"create","name":"text-posting","summary":"created"}'],
    ['staged', '{"status":"staged","action":"create","name":"text-posting","pendingId":"pending-1","summary":"staged"}'],
  ] as const)('只有真实 skill_manage %s 结果才产生通知', async (status, payload) => {
    let modelCallCount = 0;
    const driver = {
      getModelName: () => 'mock-model',
      switchModel: () => {},
      streamChat: vi.fn().mockImplementation(async function* () {
        modelCallCount++;
        if (modelCallCount === 1) {
          const toolCall = {
            id: 'skill-manage-1',
            type: 'function' as const,
            function: {
              name: 'skill_manage',
              arguments: JSON.stringify({
                action: 'create',
                name: 'text-posting',
                content: '---\\nname: text-posting\\ndescription: text\\n---\\n',
              }),
            },
          };
          yield {
            type: 'tool_calls',
            toolCalls: [toolCall],
            assistantMessage: {
              role: 'assistant',
              content: null,
              tool_calls: [toolCall],
            },
          } as LlmStreamEvent;
          return;
        }
        yield {
          type: 'complete',
          content: 'review complete',
          reasoning: '',
          assistantMessage: { role: 'assistant', content: 'review complete' },
        } as LlmStreamEvent;
      }),
    } as unknown as LlmPort;
    const registry = createParentRegistry();
    registry.callTool.mockResolvedValue({
      value: { content: [{ type: 'text', text: payload }] },
      effect: {
        kind: status === 'success' ? 'write' : 'none',
        executionStarted: true,
        completed: true,
        resources: [],
        reason: 'permission_evidence',
      },
    });
    const { service, notify } = createService(driver, registry);

    const result = await service.runReview(createReviewRequest());

    expect(result.mutations).toMatchObject([{
      status,
      action: 'create',
      name: 'text-posting',
    }]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(registry.callTool.mock.calls[0][7].securityContext).toMatchObject({
      approvalAllowed: false,
      auditSource: 'background_skill_review',
    });
  });

  it('最多运行 16 个模型工具迭代且后台 PluginRegistry 不递归安排 Review', async () => {
    let modelCallCount = 0;
    const driver = {
      getModelName: () => 'mock-model',
      switchModel: () => {},
      streamChat: vi.fn().mockImplementation(async function* () {
        modelCallCount++;
        const toolCall = {
          id: `load-${modelCallCount}`,
          type: 'function' as const,
          function: {
            name: 'load_skill',
            arguments: JSON.stringify({ name: 'text-posting' }),
          },
        };
        yield {
          type: 'tool_calls',
          toolCalls: [toolCall],
          assistantMessage: { role: 'assistant', content: null, tool_calls: [toolCall] },
        } as LlmStreamEvent;
      }),
    } as unknown as LlmPort;
    const registry = createParentRegistry();
    registry.callTool.mockResolvedValue({
      value: { content: [{ type: 'text', text: 'skill content' }] },
      effect: {
        kind: 'read',
        executionStarted: true,
        completed: true,
        resources: [],
        reason: 'declared_read_tool',
      },
    });
    const { service } = createService(driver, registry);

    await expect(service.runReview(createReviewRequest())).rejects.toThrow('16');
    expect(modelCallCount).toBe(16);
    expect(registry.callTool).toHaveBeenCalledTimes(16);
  });

  it('close 应取消排队任务并在短于模型超时的窗口内完成', async () => {
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    const driver = {
      getModelName: () => 'mock-model',
      switchModel: () => {},
      streamChat: vi.fn().mockImplementation(async function* (
        _messages: ChatMessage[],
        _tools: unknown[],
        options?: { signal?: AbortSignal },
      ) {
        markStarted();
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
        yield {
          type: 'complete',
          content: 'unreachable',
          reasoning: '',
          assistantMessage: { role: 'assistant', content: 'unreachable' },
        } as LlmStreamEvent;
      }),
    } as unknown as LlmPort;
    const registry = createParentRegistry();
    const { service } = createService(driver, registry);
    service.schedule(createReviewRequest());
    await started;

    const before = Date.now();
    await service.close(2_000);

    expect(Date.now() - before).toBeLessThan(1_000);
    expect(registry.callTool).not.toHaveBeenCalled();
    service.schedule(createReviewRequest());
    expect(driver.streamChat).toHaveBeenCalledTimes(1);
  });
});
