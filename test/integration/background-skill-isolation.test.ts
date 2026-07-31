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
import { SkillUsageStore } from '../../src/core/usecases/brain/skill-usage-store.js';
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
        toolIterationCount: 1,
        requestedToolCallCount: 1,
        historyStartIndex: 0,
        historyEndIndex: 2,
        hasFinalResponse: true,
        waitingForInteraction: false,
      },
    });

    expect(parentContext.getHistory()).toEqual(parentHistoryBefore);
    const serializedRequest = JSON.stringify(observedRequests[0].messages);
    expect(serializedRequest).not.toContain('parent-secret-history');
    expect(serializedRequest).toContain('本轮公开任务');
    expect(observedRequests[0].toolNames).toEqual(['load_skill', 'skill_manage']);
    expect(parentRegistry.callTool).not.toHaveBeenCalled();
    expect(existsSync(paths.sessionsDir) ? readdirSync(paths.sessionsDir) : []).toEqual([]);
  });
});
