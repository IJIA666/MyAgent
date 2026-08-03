/**
 * @file 后台 Skill Review 与父会话历史、会话快照和工具面的集成隔离测试。
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApplicationPaths } from '../../src/config/application-paths.js';
import type { LlmConfig } from '../../src/config/index.js';
import type {
  ChatMessage,
  LlmPort,
  LlmStreamEvent,
} from '../../src/ports/driven/llm/LlmPort.js';
import type { TokenEstimatorPort } from '../../src/ports/driven/llm/TokenEstimatorPort.js';
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
import { ToolRegistry } from '../../src/adapters/tools/toolRegistry.js';
import { SessionManager } from '../../src/core/usecases/engine/session.js';
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
    const service = new BackgroundSkillReviewService({
      toolRegistry: parentRegistry as unknown as ToolRegistryPort,
      driver,
      llmConfigProvider: () => appConfig.llm as LlmConfig,
      estimator: createEstimator(),
      contextAdapter: {
        assemble: history => structuredClone(history),
      },
      appConfig,
      skillLibrary,
      parentPermissionStateProvider: () => permissionState,
      parentCallerProvider: () => createTrustedCallContext(parentContext.getSessionId()),
    });

    await service.runReview({
      trajectory: [
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
    const service = new BackgroundSkillReviewService({
      toolRegistry: registry,
      driver,
      llmConfigProvider: () => appConfig.llm as LlmConfig,
      estimator: createEstimator(),
      contextAdapter: {
        assemble: (history: ChatMessage[]) => structuredClone(history),
      },
      appConfig,
      skillLibrary: library,
      parentPermissionStateProvider: () => parentContext.getPermissionSessionState(),
      parentCallerProvider: () => createTrustedCallContext(parentContext.getSessionId()),
      notify,
    });

    await service.runReview({
      trajectory: [
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
    } as unknown as LlmPort;
    const contextAdapter = {
      assemble: (history: ChatMessage[]) => structuredClone(history),
    } as unknown as import('../../src/ports/driven/session/ContextAdapter.js').ContextAdapter;

    // 父会话：真实 SessionManager，其 RuleManager 在构造时冻结了提示词快照。
    const parentSession = new SessionManager(
      { model: 'mock-model' } as unknown as LlmConfig,
      driver,
      createEstimator(),
      registry,
      contextAdapter,
      appConfig,
      undefined,
      library,
      pendingStore,
      approvalController,
    );

    try {
      const systemPromptBefore = parentSession.getHistory()[0]?.content ?? '';
      expect(systemPromptBefore).not.toContain('isolated-review-skill');

      // 后台复盘创建新 Skill。
      const service = parentSession['backgroundSkillReviewService'] as unknown as {
        runReview: (request: {
          trajectory: ChatMessage[];
          loadedSkills: string[];
          toolEvidence: unknown[];
          runSummary: unknown;
        }) => Promise<unknown>;
      };
      await service.runReview({
        trajectory: [
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
      // 活跃会话的首条系统消息与哈希保持冻结，不被后台 Skill 变更改写。
      expect(parentSession.getHistory()[0]?.content).toBe(systemPromptBefore);
      expect(parentSession.getSystemPromptHash()).toBeDefined();

      // 新会话读取最新元数据，可发现后台创建的 Skill。
      const freshSession = new SessionManager(
        { model: 'mock-model' } as unknown as LlmConfig,
        driver,
        createEstimator(),
        registry,
        contextAdapter,
        appConfig,
        undefined,
        library,
        pendingStore,
        approvalController,
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
});
