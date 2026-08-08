/**
 * @file 后台 Skill Review 与父会话历史、会话快照和工具面的集成隔离测试。
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApplicationPaths } from '../../src/config/application-paths.js';
import type { LlmConfig } from '../../src/config/index.js';
import type {
  ChatMessage,
  LlmPort,
  LlmPortOptions,
  LlmStreamEvent,
  SummaryGenerationOptions,
} from '../../src/ports/driven/llm/LlmPort.js';
import type { LlmClientFactoryPort } from '../../src/ports/driven/llm/LlmClientFactoryPort.js';
import type { TokenEstimatorPort } from '../../src/ports/driven/llm/TokenEstimatorPort.js';
import type { ResolvedCuratorConfig } from '../../src/config/types.js';
import type { ToolRegistryPort } from '../../src/ports/driven/tools/ToolRegistryPort.js';
import { SessionContext } from '../../src/core/domain/context.js';
import { PermissionSessionState } from '../../src/core/domain/permissions/permission-session-state.js';
import { createTrustedCallContext } from '../../src/core/domain/permissions/trusted-call-context.js';
import { BackgroundSkillReviewService } from '../../src/core/usecases/brain/background-skill-review.js';
import { SkillLibrary } from '../../src/core/usecases/brain/skill-library.js';
import {
  SkillPendingStore,
  SkillWriteApprovalController,
} from '../../src/core/usecases/brain/skill-pending-store.js';
import { SkillUsageStore } from '../../src/core/usecases/brain/skill-usage-store.js';
import { SkillCuratorBackupStore } from '../../src/core/usecases/brain/skill-curator-backup.js';
import { SkillCuratorStateStore } from '../../src/core/usecases/brain/skill-curator-state-store.js';
import { SkillCurator } from '../../src/core/usecases/brain/skill-curator.js';
import { ToolRegistry } from '../../src/adapters/tools/toolRegistry.js';
import { SessionManager } from '../../src/core/usecases/engine/session.js';
import { SubagentExecutionController } from '../../src/core/usecases/subagent/SubagentExecutionController.js';
import { SubagentRuntime } from '../../src/core/usecases/subagent/SubagentRuntime.js';
import { createMockAppConfig } from '../helpers/mock-factory.js';

let tempRoot: string | undefined;

/** 创建不会触发压缩的确定性估算器。 */
function createEstimator(): TokenEstimatorPort {
  const makeUsage = (outputReserve = 0) => ({
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
    estimateSnapshotTokens: () => makeUsage(),
    estimateRequestTokens: (_messages, _tools, outputReserve) => makeUsage(outputReserve),
    getCompactionThreshold: () => 100_000,
  };
}

afterEach(() => {
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
  vi.restoreAllMocks();
});

describe('后台 Skill Review 隔离', () => {
  it('不得读取父历史或写入主会话快照，且模型只看到受限工具面', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'background-skill-isolation-'));
    const workspace = join(tempRoot, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const paths = createApplicationPaths(workspace, {
      appDataRoot: join(tempRoot, 'app-data'),
    });
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
    const skillLibrary = new SkillLibrary(
      paths.userSkillsDir,
      paths.projectSkillsDir,
      paths.skillArchiveDir,
      new SkillUsageStore(paths.skillUsagePath),
      { enableWatcher: false },
    );
    const parentContext = new SessionContext('parent-session');
    parentContext.addMessage({ role: 'user', content: 'parent-secret-history' });
    const parentHistoryBefore = structuredClone(parentContext.getHistory());
    const observedRequests: Array<{ messages: ChatMessage[]; toolNames: string[] }> = [];
    const driver = {
      getModelName: () => 'mock-model',
      switchModel: () => {},
      abort: vi.fn(),
      streamChat: vi.fn().mockImplementation(async function* (
        messages: ChatMessage[],
        tools: Array<Record<string, unknown>>,
      ) {
        observedRequests.push({
          messages: structuredClone(messages),
          toolNames: tools.map(tool => {
            const fn = tool.function as { name?: string } | undefined;
            return fn?.name ?? String(tool.name ?? '');
          }),
        });
        yield {
          type: 'complete',
          content: 'Nothing to save',
          reasoning: '',
          assistantMessage: { role: 'assistant', content: 'Nothing to save' },
        } as LlmStreamEvent;
      }),
    } as unknown as LlmPort;
    const parentRegistry = {
      getTools: vi.fn().mockResolvedValue([
        { type: 'function', function: { name: 'skills_list' }, securityCategory: 'read' },
        { type: 'function', function: { name: 'load_skill' }, securityCategory: 'read' },
        { type: 'function', function: { name: 'skill_manage' }, securityCategory: 'write' },
        { type: 'function', function: { name: 'readFile' }, securityCategory: 'read' },
        { type: 'function', function: { name: 'BrowserNavigate' }, securityCategory: 'write' },
      ]),
      getTool: vi.fn((name: string) => ({
        name,
        securityCategory: name === 'skill_manage' ? 'write' as const : 'read' as const,
      })),
      callTool: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const permissionState = new PermissionSessionState();
    // 注入公共子代理运行器：复用文件内已有的 DelegatingLlmClientFactory 包装 mock driver，
    // 复盘经统一执行内核运行（与生产装配一致）。
    const contextAdapter = {
      assemble: (history: ChatMessage[]) => structuredClone(history),
    } as unknown as import('../../src/ports/driven/session/ContextAdapter.js').ContextAdapter;
    const subagentRuntime = new SubagentRuntime({
      appConfig,
      toolRegistry: parentRegistry as unknown as ToolRegistryPort,
      estimator: createEstimator(),
      contextAdapter,
      llmConfigProvider: () => appConfig.llm as LlmConfig,
      llmClientFactory: new DelegatingLlmClientFactory(driver),
      skillLibrary,
    });
    const service = new BackgroundSkillReviewService({
      toolRegistry: parentRegistry as unknown as ToolRegistryPort,
      parentPermissionStateProvider: () => permissionState,
      parentCallerProvider: () => createTrustedCallContext(parentContext.getSessionId()),
      subagentRuntime,
    });

    await service.runReview({
      conversationHistory: [
        { role: 'user', content: '本轮公开任务' },
        { role: 'assistant', content: '本轮公开结果' },
      ],
      loadedSkills: [],
      toolEvidence: [],
      runSummary: {
        terminalStatus: 'completed',
        modelLoopCount: 1,
        toolIterationCount: 1,
        requestedToolCallCount: 1,
        physicalRunStartIndex: 0,
        learningTrajectoryStartIndex: 0,
        historyEndIndex: 2,
        hasFinalResponse: true,
        waitingForInteraction: false,
      },
    });

    expect(parentContext.getHistory()).toEqual(parentHistoryBefore);
    const serializedRequest = JSON.stringify(observedRequests[0].messages);
    expect(serializedRequest).not.toContain('parent-secret-history');
    expect(serializedRequest).toContain('本轮公开任务');
    // 后台只看到三个 Skill 工具：目录、读取、受控写入；普通文件/Browser 被排除。
    expect(observedRequests[0].toolNames).toEqual(['skills_list', 'load_skill', 'skill_manage']);
    expect(parentRegistry.callTool).not.toHaveBeenCalled();
    expect(existsSync(paths.sessionsDir) ? readdirSync(paths.sessionsDir) : []).toEqual([]);
  });

  it('空闲期后台成功复盘只产生展示通知，父会话历史与会话快照保持不变', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'background-skill-review-display-'));
    const workspace = join(tempRoot, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const paths = createApplicationPaths(workspace, {
      appDataRoot: join(tempRoot, 'app-data'),
    });
    const appConfig = createMockAppConfig({
      workspace,
      applicationPaths: paths,
      skills: {
        backgroundReviewEnabled: true,
        creationNudgeInterval: 10,
        writeApproval: false,
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
    const approvalController = new SkillWriteApprovalController(false);
    const registry = new ToolRegistry(undefined, {
      skillLibrary: library,
      skillPendingStore: pendingStore,
      skillWriteApprovalController: approvalController,
    });

    // 后台 Review 假 LLM：第一次调用创建 Skill，第二次返回最终回复。
    let modelCalls = 0;
    const driver = {
      getModelName: () => 'mock-model',
      switchModel: () => {},
      abort: vi.fn(),
      streamChat: vi.fn().mockImplementation(async function* () {
        modelCalls++;
        if (modelCalls === 1) {
          const args = JSON.stringify({
            action: 'create',
            name: 'display-review-skill',
            content: '---\nname: display-review-skill\ndescription: 展示事件集成测试\n---\n\n# Display Skill\n',
          });
          const toolCall = {
            id: 'display-create-1',
            type: 'function' as const,
            function: { name: 'skill_manage', arguments: args },
          };
          yield {
            type: 'tool_calls',
            toolCalls: [toolCall],
            assistantMessage: { role: 'assistant', content: null, tool_calls: [toolCall] },
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

    const parentContext = new SessionContext('parent-session');
    parentContext.appConfig = appConfig;
    parentContext.addMessage({ role: 'user', content: '父会话既有消息' });
    const historyBefore = structuredClone(parentContext.getHistory());

    const notify = vi.fn();
    // 注入公共子代理运行器：与上一用例一致，经统一执行内核运行复盘。
    const contextAdapter = {
      assemble: (history: ChatMessage[]) => structuredClone(history),
    } as unknown as import('../../src/ports/driven/session/ContextAdapter.js').ContextAdapter;
    const subagentRuntime = new SubagentRuntime({
      appConfig,
      toolRegistry: registry,
      estimator: createEstimator(),
      contextAdapter,
      llmConfigProvider: () => appConfig.llm as LlmConfig,
      llmClientFactory: new DelegatingLlmClientFactory(driver),
      skillLibrary: library,
    });
    const service = new BackgroundSkillReviewService({
      toolRegistry: registry,
      parentPermissionStateProvider: () => parentContext.getPermissionSessionState(),
      parentCallerProvider: () => createTrustedCallContext(parentContext.getSessionId()),
      subagentRuntime,
      notify,
    });

    await service.runReview({
      conversationHistory: [
        { role: 'user', content: '本轮后台任务' },
        { role: 'assistant', content: '本轮后台结果' },
      ],
      loadedSkills: [],
      toolEvidence: [],
      runSummary: {
        terminalStatus: 'completed',
        modelLoopCount: 1,
        toolIterationCount: 1,
        requestedToolCallCount: 1,
        physicalRunStartIndex: 0,
        learningTrajectoryStartIndex: 0,
        historyEndIndex: 2,
        hasFinalResponse: true,
        waitingForInteraction: false,
      },
    });

    // 复盘结果只作为展示数据通知宿主：状态、动作与 Skill 名称。
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      status: 'success',
      action: 'create',
      name: 'display-review-skill',
    });
    // 父会话历史与会话快照保持不变，后台写入不落主会话盘。
    expect(parentContext.getHistory()).toEqual(historyBefore);
    expect(existsSync(paths.sessionsDir) ? readdirSync(paths.sessionsDir) : []).toEqual([]);
    // Skill 已进入实时库，供后续会话发现。
    expect(library.get('display-review-skill')).toBeDefined();
  });

  it('后台创建 Skill 后父会话首条系统消息不变，新会话可发现新 Skill', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'background-skill-snapshot-'));
    const workspace = join(tempRoot, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const paths = createApplicationPaths(workspace, {
      appDataRoot: join(tempRoot, 'app-data'),
    });
    const appConfig = createMockAppConfig({
      workspace,
      applicationPaths: paths,
      skills: {
        backgroundReviewEnabled: true,
        creationNudgeInterval: 10,
        writeApproval: false,
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
    const approvalController = new SkillWriteApprovalController(false);
    const subagentController = new SubagentExecutionController();
    const registry = new ToolRegistry(undefined, {
      skillLibrary: library,
      skillPendingStore: pendingStore,
      skillWriteApprovalController: approvalController,
      subagentExecutionPort: subagentController,
    });

    // 后台 Review 假 LLM：第一次调用创建 Skill，第二次返回最终回复。
    let modelCalls = 0;
    const driver = {
      getModelName: () => 'mock-model',
      switchModel: () => {},
      abort: vi.fn(),
      streamChat: vi.fn().mockImplementation(async function* () {
        modelCalls++;
        if (modelCalls === 1) {
          const args = JSON.stringify({
            action: 'create',
            name: 'isolated-review-skill',
            content: '---\nname: isolated-review-skill\ndescription: 快照冻结集成测试\n---\n# Snapshot Skill\n',
          });
          const toolCall = {
            id: 'snapshot-create-1',
            type: 'function' as const,
            function: { name: 'skill_manage', arguments: args },
          };
          yield {
            type: 'tool_calls',
            toolCalls: [toolCall],
            assistantMessage: { role: 'assistant', content: null, tool_calls: [toolCall] },
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
      chat: vi.fn().mockResolvedValue(''),
      generateSummaryAsync: vi.fn().mockResolvedValue(''),
    } as unknown as LlmPort;
    const llmClientFactory = new DelegatingLlmClientFactory(driver);
    const contextAdapter = {
      assemble: (history: ChatMessage[]) => structuredClone(history),
    } as unknown as import('../../src/ports/driven/session/ContextAdapter.js').ContextAdapter;

    // 父会话：真实 SessionManager，其 RuleManager 在构造时冻结了提示词快照。
    const parentSession = new SessionManager(
      appConfig.llm,
      driver,
      createEstimator(),
      registry,
      contextAdapter,
      appConfig,
      undefined,
      library,
      pendingStore,
      approvalController,
      undefined,
      undefined,
      subagentController,
      llmClientFactory,
    );

    try {
      const systemPromptBefore = parentSession.getHistory()[0]?.content ?? '';
      expect(systemPromptBefore).not.toContain('isolated-review-skill');

      // 后台复盘创建新 Skill。
      const service = parentSession['backgroundSkillReviewService'] as unknown as {
        runReview: (request: {
          conversationHistory: ChatMessage[];
          loadedSkills: string[];
          toolEvidence: unknown[];
          runSummary: unknown;
        }) => Promise<unknown>;
      };
      await service.runReview({
        conversationHistory: [
          { role: 'user', content: '后台任务' },
          { role: 'assistant', content: '后台结果' },
        ],
        loadedSkills: [],
        toolEvidence: [],
        runSummary: {
          terminalStatus: 'completed',
          modelLoopCount: 1,
          toolIterationCount: 1,
          requestedToolCallCount: 1,
          physicalRunStartIndex: 0,
          learningTrajectoryStartIndex: 0,
          historyEndIndex: 2,
          hasFinalResponse: true,
          waitingForInteraction: false,
        },
      });

      expect(library.get('isolated-review-skill')).toBeDefined();
      // 生产 SessionManager 通过独立工厂创建子模型，Skill Review 不写通用 transcript。
      expect(llmClientFactory.clients).toHaveLength(1);
      expect(llmClientFactory.clients[0]).not.toBe(driver);
      expect(existsSync(paths.subagentsDir) ? readdirSync(paths.subagentsDir) : []).toEqual([]);
      // 活跃会话的首条系统消息与哈希保持冻结，不被后台 Skill 变更改写。
      expect(parentSession.getHistory()[0]?.content).toBe(systemPromptBefore);
      expect(parentSession.getSystemPromptHash()).toBeDefined();

      // 新会话读取最新元数据，可发现后台创建的 Skill。
      // 本用例不调用复盘，注入拒绝接受的 mock scheduler 避免创建 Review 服务
      //（子代理依赖未注入时服务装配会抛错，此处无复盘需求故直接分流）。
      const freshSession = new SessionManager(
        appConfig.llm,
        driver,
        createEstimator(),
        registry,
        contextAdapter,
        appConfig,
        undefined,
        library,
        pendingStore,
        approvalController,
        { schedule: () => ({ accepted: false, taskId: null }) },
      );
      try {
        expect(freshSession.getAvailableSkills()
          .map(skill => skill.name)).toContain('isolated-review-skill');
        expect(freshSession.getHistory()[0]?.content).toContain('isolated-review-skill');
      } finally {
        await freshSession.close();
      }
    } finally {
      await parentSession.close();
    }
  });

  it('真实 SessionManager 注入 Curator 后按 due cadence 复用隔离运行器且不污染父历史', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'background-curator-runtime-'));
    const workspace = join(tempRoot, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const paths = createApplicationPaths(workspace, {
      appDataRoot: join(tempRoot, 'app-data'),
    });
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
    const library = new SkillLibrary(
      paths.userSkillsDir,
      paths.projectSkillsDir,
      paths.skillArchiveDir,
      usageStore,
      { enableWatcher: false },
    );
    const candidateDir = join(paths.userSkillsDir, 'curator-candidate');
    mkdirSync(candidateDir, { recursive: true });
    writeFileSync(
      join(candidateDir, 'SKILL.md'),
      '---\nname: curator-candidate\ndescription: Curator 集成候选\n---\n\n候选正文\n',
      'utf8',
    );
    // 候选在 SkillLibrary 构造后写入，显式刷新索引以模拟实时库更新后的 Curator 扫描。
    library.reloadSkills();
    await usageStore.markAgentCreated('curator-candidate');
    const stateStore = new SkillCuratorStateStore(paths.skillCuratorStatePath);
    stateStore.writeBaseline(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000));
    const curatorConfig: ResolvedCuratorConfig = {
      enabled: true,
      intervalHours: 1,
      minIdleHours: 1,
      staleAfterDays: 365,
      archiveAfterDays: 730,
      consolidate: true,
      backup: { enabled: false, keep: 1 },
    };
    const backupStore = new SkillCuratorBackupStore(
      paths.userSkillsDir,
      paths.skillArchiveDir,
      paths.skillUsagePath,
      paths.skillCuratorStatePath,
      paths.skillCuratorBackupsDir,
      1,
    );
    const curator = new SkillCurator(
      curatorConfig,
      library,
      usageStore,
      stateStore,
      backupStore,
    );
    const subagentController = new SubagentExecutionController();
    const registry = new ToolRegistry(undefined, {
      skillLibrary: library,
      skillPendingStore: new SkillPendingStore(paths.skillPendingDir, library),
      skillWriteApprovalController: new SkillWriteApprovalController(false),
      subagentExecutionPort: subagentController,
    });
    const observedTools: string[][] = [];
    const driver = {
      getModelName: () => 'mock-model',
      switchModel: () => {},
      abort: vi.fn(),
      streamChat: vi.fn().mockImplementation(async function* (
        _messages: ChatMessage[],
        tools: Array<Record<string, unknown>>,
      ) {
        observedTools.push(tools.map(getToolDefinitionName));
        yield {
          type: 'complete',
          content: 'Nothing to save',
          reasoning: '',
          assistantMessage: { role: 'assistant', content: 'Nothing to save' },
        } as LlmStreamEvent;
      }),
      chat: vi.fn().mockResolvedValue(''),
      generateSummaryAsync: vi.fn().mockResolvedValue(''),
    } as unknown as LlmPort;
    const llmClientFactory = new DelegatingLlmClientFactory(driver);
    const contextAdapter = {
      assemble: (history: ChatMessage[]) => structuredClone(history),
    } as unknown as import('../../src/ports/driven/session/ContextAdapter.js').ContextAdapter;
    const session = new SessionManager(
      appConfig.llm,
      driver,
      createEstimator(),
      registry,
      contextAdapter,
      appConfig,
      undefined,
      library,
      undefined,
      undefined,
      undefined,
      curator,
      subagentController,
      llmClientFactory,
    );
    const parentHistory = structuredClone(session.getHistory());

    try {
      await session.open();
      const completed = await waitForCondition(() => (
        stateStore.read().status === 'healthy'
        && stateStore.read().state?.lastRunAt !== null
      ));

      expect(completed).toBe(true);
      expect(llmClientFactory.clients).toHaveLength(1);
      expect(observedTools[0]).toEqual(['skills_list', 'load_skill', 'skill_manage']);
      expect(library.get('curator-candidate')).toBeDefined();
      expect(session.getHistory()).toEqual(parentHistory);
      expect(existsSync(paths.sessionsDir) ? readdirSync(paths.sessionsDir) : []).toEqual([]);
      expect(existsSync(paths.subagentsDir) ? readdirSync(paths.subagentsDir) : []).toEqual([]);
    } finally {
      await session.close();
    }
  });
});

/** 从 OpenAI function 定义中读取工具名。 */
function getToolDefinitionName(tool: Record<string, unknown>): string {
  const fn = tool.function as { name?: unknown } | undefined;
  return typeof fn?.name === 'string' ? fn.name : String(tool.name ?? '');
}

/** 等待 SessionManager 异步 due-check 完成，避免把固定睡眠当成生命周期同步点。 */
async function waitForCondition(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      return false;
    }
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  return true;
}

/** 为隔离 Review 创建独立客户端对象，保留测试模型的确定性脚本。 */
class DelegatingLlmClientFactory implements LlmClientFactoryPort {
  /** 已创建的子客户端。 */
  public readonly clients: LlmPort[] = [];

  /**
   * @param source - 测试用主模型脚本
   */
  constructor(private readonly source: LlmPort) {}

  /**
   * @param _config - 公共运行器的配置快照
   * @returns 与父驱动对象身份不同的客户端
   */
  public create(_config: LlmConfig): LlmPort {
    const client: LlmPort = {
      getModelName: () => this.source.getModelName(),
      switchModel: (config, options) => this.source.switchModel(config, options),
      abort: () => this.source.abort(),
      streamChat: (messages, tools, options?: LlmPortOptions) => (
        this.source.streamChat(messages, tools, options)
      ),
      chat: async (messages, options?: LlmPortOptions) => this.source.chat(messages, options),
      generateSummaryAsync: async (
        messages,
        options?: SummaryGenerationOptions,
      ) => this.source.generateSummaryAsync(messages, options),
    };
    this.clients.push(client);
    return client;
  }
}
