/**
 * @file BackgroundSkillReviewService 的隔离 Agent、prompt、结果门槛与取消测试。
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApplicationPaths } from '../../../../src/config/application-paths.js';
import type { LlmConfig } from '../../../../src/config/index.js';
import type {
  ChatMessage,
  LlmPort,
  LlmPortOptions,
  LlmStreamEvent,
  SummaryGenerationOptions,
} from '../../../../src/ports/driven/llm/LlmPort.js';
import type { LlmClientFactoryPort } from '../../../../src/ports/driven/llm/LlmClientFactoryPort.js';
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
import { SubagentRuntime } from '../../../../src/core/usecases/subagent/SubagentRuntime.js';
import { SubagentTranscriptStore } from '../../../../src/core/usecases/subagent/SubagentTranscriptStore.js';
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
    conversationHistory: [
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
      modelLoopCount: 2,
      toolIterationCount: 1,
      requestedToolCallCount: 1,
      physicalRunStartIndex: 0,
      learningTrajectoryStartIndex: 0,
      historyEndIndex: 4,
      hasFinalResponse: true,
      waitingForInteraction: false,
    },
  };
}

/** 构造一次完整 complete 流事件。 */
function completeEvent(content: string): LlmStreamEvent {
  return {
    type: 'complete',
    content,
    reasoning: '',
    assistantMessage: { role: 'assistant', content },
  } as LlmStreamEvent;
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

/** 创建具备三个 Skill 工具定义的父 ToolRegistry mock。 */
function createParentRegistry() {
  return {
    getTools: vi.fn().mockResolvedValue([
      {
        type: 'function',
        function: { name: 'skills_list', parameters: { type: 'object' } },
        securityCategory: 'read',
      },
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
  // 测试模型保留原有 mock 的观测能力，但通过新客户端对象进入公共运行器，
  // 从而同时验证独立 LLM 工厂、Skill 专用运行配置和不落盘契约。
  const llmClientFactory = new DelegatingLlmClientFactory(driver);
  const subagentRuntime = new SubagentRuntime({
    appConfig: environment.appConfig,
    toolRegistry: registry as unknown as ToolRegistryPort,
    estimator: createEstimator(),
    contextAdapter,
    llmConfigProvider: () => environment.appConfig.llm as LlmConfig,
    llmClientFactory,
    skillLibrary: environment.skillLibrary,
    transcriptStore: new SubagentTranscriptStore(environment.paths.subagentsDir),
  });
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
    subagentRuntime,
    notify,
  });
  return { service, notify, llmClientFactory, ...environment };
}

/** 为旧测试 Fake 包装一个完整的、每次创建都独立的 LLM 客户端。 */
class DelegatingLlmClientFactory implements LlmClientFactoryPort {
  /** 已创建的子客户端，供测试核对实例隔离。 */
  public readonly clients: LlmPort[] = [];

  /**
   * @param source - 只实现了测试所需最小方法集的旧 Fake
   */
  constructor(private readonly source: LlmPort) {}

  /**
   * 创建不共享客户端对象的代理；旧 Fake 缺少的非流式方法使用安全空实现。
   *
   * @param config - 冻结的 LLM 配置快照
   * @returns 可被公共运行器完整消费的独立客户端
   */
  public create(_config: LlmConfig): LlmPort {
    const source = this.source as unknown as Partial<LlmPort>;
    const client: LlmPort = {
      getModelName: () => source.getModelName?.() ?? 'mock-model',
      switchModel: (config, options) => {
        source.switchModel?.call(this.source, config, options);
      },
      abort: () => {
        source.abort?.call(this.source);
      },
      streamChat: (messages, tools, options?: LlmPortOptions) => {
        if (!source.streamChat) {
          throw new Error('测试 Fake 未提供 streamChat');
        }
        return source.streamChat.call(this.source, messages, tools, options);
      },
      chat: async (messages, options?: LlmPortOptions) => (
        source.chat?.call(this.source, messages, options) ?? ''
      ),
      generateSummaryAsync: async (
        messages,
        options?: SummaryGenerationOptions,
      ) => source.generateSummaryAsync?.call(this.source, messages, options) ?? '',
    };
    this.clients.push(client);
    return client;
  }
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

  it('Review 提示词固化三工具上限与「目录—完整性收敛—读取—写入」决策顺序', () => {
    // 三工具固定上限，不扩大到文件/Shell/MCP/交互。
    expect(BACKGROUND_SKILL_REVIEW_PROMPT).toContain('skills_list、load_skill 与 skill_manage');
    // 先用 skills_list 查看实时目录，遇到 complete=false 用 category/query 收敛。
    expect(BACKGROUND_SKILL_REVIEW_PROMPT).toContain('先用 skills_list');
    expect(BACKGROUND_SKILL_REVIEW_PROMPT).toContain('complete=false');
    expect(BACKGROUND_SKILL_REVIEW_PROMPT).toContain('category 或 query 收敛');
    // 完整目录结果之前禁止断言无候选或创建新 Skill。
    expect(BACKGROUND_SKILL_REVIEW_PROMPT).toContain('不得断言');
    expect(BACKGROUND_SKILL_REVIEW_PROMPT).toContain('直接创建新 Skill');
    // 目录查看不能替代准确预读。
    expect(BACKGROUND_SKILL_REVIEW_PROMPT).toContain('目录不能替代读取');
  });

  it('复盘指令只携带当前任务辅助证据，不序列化对话历史', () => {
    const baseRequest = createReviewRequest();
    const request: BackgroundSkillReviewRequest = {
      ...baseRequest,
      conversationHistory: [
        { role: 'system', content: '父会话私密系统配置' },
        ...baseRequest.conversationHistory,
        { role: 'tool', tool_call_id: 'large', content: 'x'.repeat(7_000) },
      ],
    };
    const input = buildBackgroundReviewInput(request);

    // 对话历史（含父 system 与超长工具输出）不进入复盘指令文本：
    // 隔离 Agent 已通过 conversationHistory 原生回放，不再 JSON 嵌套或二次裁剪。
    expect(input).not.toContain('父会话私密系统配置');
    expect(input).not.toContain('发布一条纯文字帖子');
    expect(input).not.toContain('[truncated');
    expect(input).toContain('"loadedSkills"');
    expect(input).toContain('text-posting');
    expect(input).toContain('"toolEvidence"');
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
    expect(receivedTools[0]).toHaveLength(3);
  });

  it.each([
    ['success', '{"status":"success","action":"create","name":"text-posting","summary":"created"}'],
    ['staged', '{"status":"staged","action":"create","name":"text-posting","pendingId":"pending-1","summary":"staged"}'],
    ['error', '{"status":"error","action":"create","name":"text-posting","summary":"failed"}'],
    // 重复复盘上下文下相同内容 patch 的 no-change 结果同样不得进入 mutations 或通知。
    ['no_change', '{"status":"error","action":"patch","name":"text-posting","error":"替换后内容未变化"}'],
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

    if (status === 'error' || status === 'no_change') {
      // 工具失败或无变化不产生变更摘要，也不得发送任何成功展示事件。
      expect(result.mutations).toEqual([]);
      expect(notify).not.toHaveBeenCalled();
      return;
    }
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

    // 公共运行器把迭代上限作为结构化失败收口，服务层只暴露后台业务结果，
    // 因此这里不再依赖旧装配抛出的字符串异常。
    const result = await service.runReview(createReviewRequest());
    expect(result.cancelled).toBe(false);
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

  it('FIFO 串行执行，任一时刻最多一个活动复盘', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
    let markSecondStarted!: () => void;
    const secondStarted = new Promise<void>(resolve => { markSecondStarted = resolve; });
    let callCount = 0;
    const driver = {
      getModelName: () => 'mock-model',
      switchModel: () => {},
      streamChat: vi.fn().mockImplementation(async function* () {
        callCount++;
        if (callCount === 1) {
          markFirstStarted();
          await firstGate;
          yield completeEvent('first done');
        } else {
          markSecondStarted();
          yield completeEvent('second done');
        }
      }),
    } as unknown as LlmPort;
    const { service } = createService(driver, createParentRegistry());

    service.schedule(createReviewRequest());
    service.schedule(createReviewRequest());
    await firstStarted;
    await Promise.resolve();
    // 第一个任务仍在运行，第二个必须留在队列中等待。
    expect(callCount).toBe(1);

    releaseFirst();
    await secondStarted;
    expect(callCount).toBe(2);
    await service.close(2_000);
  });

  it('前一个复盘失败后继续处理队首请求', async () => {
    let markRecovered!: () => void;
    const recovered = new Promise<void>(resolve => { markRecovered = resolve; });
    let callCount = 0;
    const driver = {
      getModelName: () => 'mock-model',
      switchModel: () => {},
      streamChat: vi.fn().mockImplementation(async function* () {
        callCount++;
        if (callCount === 1) {
          throw new Error('model failure');
        }
        markRecovered();
        yield completeEvent('recovered');
      }),
    } as unknown as LlmPort;
    const { service } = createService(driver, createParentRegistry());

    service.schedule(createReviewRequest());
    service.schedule(createReviewRequest());
    await recovered;

    expect(callCount).toBe(2);
    await service.close(2_000);
  });

  it('关闭丢弃未启动请求并取消活动任务', async () => {
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    let callCount = 0;
    const driver = {
      getModelName: () => 'mock-model',
      switchModel: () => {},
      streamChat: vi.fn().mockImplementation(async function* (
        _messages: ChatMessage[],
        _tools: unknown[],
        options?: { signal?: AbortSignal },
      ) {
        callCount++;
        markStarted();
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
        yield completeEvent('unreachable');
      }),
    } as unknown as LlmPort;
    const { service } = createService(driver, createParentRegistry());

    service.schedule(createReviewRequest());
    service.schedule(createReviewRequest());
    await started;
    await service.close(2_000);

    // 队列中的第二个请求被丢弃，活动任务被取消。
    expect(callCount).toBe(1);
  });

  it('关闭后 schedule 同步返回未接受，不创建任务或队列条目', async () => {
    const driver = {
      getModelName: () => 'mock-model',
      switchModel: () => {},
      streamChat: vi.fn().mockImplementation(async function* () {
        yield completeEvent('done');
      }),
    } as unknown as LlmPort;
    const registry = createParentRegistry();
    const { service } = createService(driver, registry);

    await service.close(2_000);
    const acceptance = service.schedule(createReviewRequest());

    expect(acceptance).toEqual({ accepted: false, taskId: null });
    expect(driver.streamChat).not.toHaveBeenCalled();
    expect(registry.callTool).not.toHaveBeenCalled();
  });

  it('入队时复制不可变快照，调用方后续修改不影响队列', async () => {
    const observed: ChatMessage[][] = [];
    const driver = {
      getModelName: () => 'mock-model',
      switchModel: () => {},
      streamChat: vi.fn().mockImplementation(async function* (
        messages: ChatMessage[],
      ) {
        observed.push(structuredClone(messages));
        yield completeEvent('done');
      }),
    } as unknown as LlmPort;
    const { service } = createService(driver, createParentRegistry());

    const request = createReviewRequest();
    service.schedule(request);
    // 调用方在入队后篡改原请求：队列快照必须不受影响。
    (request.conversationHistory as ChatMessage[]).push({
      role: 'user',
      content: '入队后篡改',
    });
    await service.close(2_000);

    const serialized = JSON.stringify(observed);
    expect(serialized).not.toContain('入队后篡改');
    expect(serialized).toContain('发布一条纯文字帖子');
  });

  it('隔离 Review 原样回放父会话消息，只保留自身 system 并追加复盘指令', async () => {
    const observed: ChatMessage[][] = [];
    const driver = {
      getModelName: () => 'mock-model',
      switchModel: () => {},
      streamChat: vi.fn().mockImplementation(async function* (
        messages: ChatMessage[],
      ) {
        observed.push(structuredClone(messages));
        yield completeEvent('done');
      }),
    } as unknown as LlmPort;
    const { service, llmClientFactory, paths } = createService(driver, createParentRegistry());

    await service.runReview({
      ...createReviewRequest(),
      conversationHistory: [
        { role: 'system', content: '父会话私密系统配置' },
        { role: 'user', content: '发布一条纯文字帖子' },
        { role: 'assistant', content: '先检查登录状态' },
        { role: 'tool', tool_call_id: 'check-1', content: 'logged-in' },
        { role: 'assistant', content: '发布成功' },
      ],
    });

    const first = observed[0];
    // 父 system 被剥离：模型请求只保留隔离上下文自身的首条 system。
    expect(first.filter(message => message.role === 'system')).toHaveLength(1);
    expect(first.some(message => message.content === '父会话私密系统配置')).toBe(false);
    // 父会话 user/assistant/tool 消息按原角色与工具关联字段回放。
    expect(first.some(message => (
      message.role === 'user' && message.content === '发布一条纯文字帖子'
    ))).toBe(true);
    expect(first.some(message => (
      message.role === 'assistant' && message.content === '发布成功'
    ))).toBe(true);
    expect(first.some(message => (
      message.role === 'tool' && message.tool_call_id === 'check-1'
    ))).toBe(true);
    // 复盘指令作为末尾 user 消息追加，而不是嵌套进单条 JSON 轨迹。
    const tail = first[first.length - 1];
    expect(tail.role).toBe('user');
    expect(tail.content).toContain('Skill Review Agent');
    // Review 通过独立客户端工厂运行，且 Skill 专用任务明确不写 transcript。
    expect(llmClientFactory.clients).toHaveLength(1);
    expect(llmClientFactory.clients[0]).not.toBe(driver);
    expect(existsSync(paths.subagentsDir) ? readdirSync(paths.subagentsDir) : []).toEqual([]);
  });

  it('超过 80 条且单条超过 6000 字符的快照原样回放，Review 自身不再裁剪或 JSON 嵌套', async () => {
    const observed: ChatMessage[][] = [];
    const driver = {
      getModelName: () => 'mock-model',
      switchModel: () => {},
      streamChat: vi.fn().mockImplementation(async function* (
        messages: ChatMessage[],
      ) {
        observed.push(structuredClone(messages));
        yield completeEvent('done');
      }),
    } as unknown as LlmPort;
    const { service } = createService(driver, createParentRegistry());

    const largeToolResult = 'A'.repeat(7_000);
    const history: ChatMessage[] = [
      { role: 'user', content: '起点任务' },
      ...Array.from({ length: 90 }, (_, index) => ({
        role: 'user' as const,
        content: `后续消息 ${index}`,
      })),
      { role: 'tool', tool_call_id: 'large-1', content: largeToolResult },
      { role: 'assistant', content: '最终回复' },
    ];
    await service.runReview({
      ...createReviewRequest(),
      conversationHistory: history,
    });

    const first = observed[0];
    // 90 条后续消息全部保留（超过旧上限 80 条），不被裁剪。
    expect(first.filter(message => message.content === '起点任务')).toHaveLength(1);
    expect(first.filter(message => (
      typeof message.content === 'string' && message.content.startsWith('后续消息')
    ))).toHaveLength(90);
    // 超长工具结果保持原长度，不再被逐消息字符截断。
    const large = first.find(message => message.tool_call_id === 'large-1');
    expect(large?.content).toBe(largeToolResult);
    // 消息以原生数组回放，复盘指令仍作为末尾 user 消息追加。
    expect(first[first.length - 1].role).toBe('user');
  });
});
