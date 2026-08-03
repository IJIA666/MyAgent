/**
 * @file 后台 Skill 学习触发与隔离契约。
 * 固定阈值基线、模型循环计数定义、非阻塞排队和受限工具面。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LlmConfig } from '../../src/config/index.js';
import type {
  ChatMessage,
  LlmPort,
  LlmStreamEvent,
} from '../../src/ports/driven/llm/LlmPort.js';
import type { ToolRegistryPort } from '../../src/ports/driven/tools/ToolRegistryPort.js';
import { AgentTracer } from '../../src/core/domain/tracer.js';
import { SessionContext } from '../../src/core/domain/context.js';
import { PermissionSessionState } from '../../src/core/domain/permissions/permission-session-state.js';
import { createTrustedCallContext } from '../../src/core/domain/permissions/trusted-call-context.js';
import { BackgroundSkillAgent } from '../../src/core/usecases/brain/background-skill-agent.js';
import {
  BACKGROUND_SKILL_REVIEW_PROMPT,
} from '../../src/core/usecases/brain/background-skill-review.js';
import { AgentLoop } from '../../src/core/usecases/engine/agent-loop.js';
import { PluginRegistry } from '../../src/core/usecases/plugins/plugin-registry.js';
import {
  SkillLearningPlugin,
} from '../../src/core/usecases/plugins/SkillLearningPlugin.js';
import {
  HookEventName,
  type AgentRunSummary,
  type HookContext,
} from '../../src/core/usecases/plugins/plugin-types.js';
import { createMockAppConfig } from '../helpers/mock-factory.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('Background Skill learning contract', () => {
  it('默认阈值 10 按模型循环跨 run 累计，缺少 summary 不触发', async () => {
    const config = createMockAppConfig();
    expect(config.skills.creationNudgeInterval).toBe(10);

    let finishBackground: (() => void) | undefined;
    const background = new Promise<void>(resolvePromise => {
      finishBackground = resolvePromise;
    });
    const schedule = vi.fn(() => {
      void background;
      return { accepted: true, taskId: 'contract-task' };
    });
    const plugin = new SkillLearningPlugin(config.skills, {
      schedule,
    });
    const context = new SessionContext('contract-learning');
    const next = vi.fn().mockResolvedValue(undefined);

    await plugin.hooks[HookEventName.RunEnd](
      hookContext(context, undefined),
      next,
    );
    await plugin.hooks[HookEventName.RunEnd](
      hookContext(context, completedSummary(4)),
      next,
    );
    expect(schedule).not.toHaveBeenCalled();
    await plugin.hooks[HookEventName.RunEnd](
      hookContext(context, completedSummary(6)),
      next,
    );

    expect(schedule).toHaveBeenCalledTimes(1);
    finishBackground?.();
  });

  it('RunEnd 独立统计模型循环、工具型响应、并行请求和最终回复', async () => {
    const context = new SessionContext('contract-run-summary');
    context.appConfig = createMockAppConfig();
    let modelCalls = 0;
    const driver = {
      getModelName: () => 'mock',
      switchModel: () => undefined,
      streamChat: vi.fn().mockImplementation(async function* () {
        modelCalls++;
        if (modelCalls === 1) {
          const toolCalls = ['one', 'two'].map(name => ({
            id: `call-${name}`,
            type: 'function' as const,
            function: { name: 'read_test', arguments: '{}' },
          }));
          yield {
            type: 'tool_calls',
            toolCalls,
            assistantMessage: {
              role: 'assistant',
              content: '先并行检查',
              tool_calls: toolCalls,
            },
          } as LlmStreamEvent;
          return;
        }
        yield {
          type: 'complete',
          content: '检查完成',
          reasoning: '',
          assistantMessage: { role: 'assistant', content: '检查完成' },
        } as LlmStreamEvent;
      }),
    } as unknown as LlmPort;
    const registry = {
      getTools: vi.fn().mockResolvedValue([{ name: 'read_test', securityCategory: 'read' }]),
      getTool: vi.fn().mockReturnValue({ name: 'read_test', securityCategory: 'read' }),
      callTool: vi.fn().mockResolvedValue({
        value: { content: [{ type: 'text', text: 'ok' }] },
        effect: {
          kind: 'read',
          executionStarted: true,
          completed: true,
          resources: [],
          reason: 'declared_read_tool',
        },
      }),
    } as unknown as ToolRegistryPort;
    let summary: Readonly<AgentRunSummary> | undefined;
    const plugins = new PluginRegistry();
    plugins.register({
      name: 'SummaryContractProbe',
      weight: 0,
      hooks: {
        [HookEventName.RunEnd]: async (hookContext, next) => {
          summary = hookContext.runSummary;
          await next();
        },
      },
    });
    const loop = new AgentLoop({
      toolRegistry: registry,
      context,
      driver,
      contextAdapter: { assemble: history => history },
      ruleManager: { getProjectRules: () => '' } as never,
      contextRepo: {
        saveSession: async () => undefined,
        saveState: async () => undefined,
      } as never,
      toolDispatcher: {
        handleLargeToolOutput: (_name: string, content: string) => ({
          content,
          isTruncated: false,
        }),
      } as never,
      contextBudgetCoordinator: {
        coordinate: async (request: {
          messages: ChatMessage[];
          tools: Record<string, unknown>[];
        }) => ({
          messages: request.messages,
          tools: request.tools,
          control: { action: 'continue' as const },
          estimatedUsage: zeroUsage(),
          compactionResult: {
            status: 'skipped' as const,
            strategy: 'none' as const,
            tokensBefore: 0,
            tokensAfter: 0,
            prunedTokens: 0,
            reason: 'contract',
          },
        }),
      } as never,
      pluginRegistry: plugins,
    });
    context.addMessage({ role: 'user', content: '执行纯文字发帖前检查' });
    const tracerRoot = mkdtempSync(join(tmpdir(), 'skill-summary-contract-'));
    tempRoots.push(tracerRoot);
    for await (const event of loop.chat(
      undefined,
      new AgentTracer(join(tracerRoot, 'traces'), join(tracerRoot, 'audits'), 'summary'),
      { model: 'mock' } as LlmConfig,
    )) {
      void event;
    }

    expect(summary).toMatchObject({
      terminalStatus: 'completed',
      modelLoopCount: 2,
      toolIterationCount: 1,
      requestedToolCallCount: 2,
      hasFinalResponse: true,
      waitingForInteraction: false,
    });
  });

  it('受限工具面只有 skills_list/load_skill/skill_manage，且只有真实 success/staged 产生通知', async () => {
    const onSkillMutation = vi.fn();
    let responsePayload = '模型叙事：已保存';
    const parent = {
      getTools: vi.fn().mockResolvedValue([
        { name: 'skills_list' },
        { name: 'load_skill' },
        { name: 'skill_manage' },
        { name: 'readFile' },
      ]),
      getTool: vi.fn((name: string) => ({ name, securityCategory: 'write' })),
      callTool: vi.fn(async (
        _name: string,
        _args: Record<string, unknown>,
        _session: unknown,
        _interaction: unknown,
        _signal: unknown,
        _id: unknown,
        _timeout: unknown,
        hooks: { prepareExecution?: () => Promise<void> },
      ) => {
        await hooks.prepareExecution?.();
        return {
          value: { content: [{ type: 'text', text: responsePayload }] },
          effect: {
            kind: 'write',
            executionStarted: true,
            completed: true,
            resources: [],
            reason: 'permission_evidence',
          },
        };
      }),
    };
    const agent = new BackgroundSkillAgent(parent as unknown as ToolRegistryPort, {
      parentPermissionState: new PermissionSessionState(),
      parentCaller: createTrustedCallContext('parent', 'interactive'),
      parentToolNames: ['skills_list', 'load_skill', 'skill_manage', 'readFile'],
      callerId: 'contract',
      onSkillMutation,
    });

    expect((await agent.getTools()).map(tool => (tool as { name: string }).name))
      .toEqual(['skills_list', 'load_skill', 'skill_manage']);
    await agent.callTool('skill_manage', { action: 'create', name: 'narrative' });
    expect(onSkillMutation).not.toHaveBeenCalled();

    responsePayload = JSON.stringify({
      status: 'success',
      action: 'create',
      name: 'real-skill',
    });
    await agent.callTool('skill_manage', { action: 'create', name: 'real-skill' });
    expect(onSkillMutation).toHaveBeenCalledWith({
      status: 'success',
      action: 'create',
      name: 'real-skill',
    });
    await expect(agent.callTool('readFile', {})).rejects.toThrow('不允许调用工具');
  });

  it('Review prompt 强制跨实例、验证、正向路径并允许 no-op，不含数量目标', () => {
    expect(BACKGROUND_SKILL_REVIEW_PROMPT).toContain('跨实例性');
    expect(BACKGROUND_SKILL_REVIEW_PROMPT).toContain('验证性');
    expect(BACKGROUND_SKILL_REVIEW_PROMPT).toContain('正向路径优先');
    expect(BACKGROUND_SKILL_REVIEW_PROMPT).toContain('Nothing to save');
    expect(BACKGROUND_SKILL_REVIEW_PROMPT).not.toMatch(/至少(更新|创建|归档)\s*\d+/);
    expect(BACKGROUND_SKILL_REVIEW_PROMPT).not.toContain('多数运行必须修改');
  });

  it('Review prompt 固化三工具上限与「目录—完整性收敛—读取—写入」顺序', () => {
    expect(BACKGROUND_SKILL_REVIEW_PROMPT).toContain('skills_list、load_skill 与 skill_manage');
    expect(BACKGROUND_SKILL_REVIEW_PROMPT).toContain('先用 skills_list');
    expect(BACKGROUND_SKILL_REVIEW_PROMPT).toContain('complete=false');
    expect(BACKGROUND_SKILL_REVIEW_PROMPT).toContain('category 或 query 收敛');
    expect(BACKGROUND_SKILL_REVIEW_PROMPT).toContain('目录不能替代读取');
  });
});

/** 构造只有纯文本模型循环的成功 RunEnd 摘要。 */
function completedSummary(modelLoopCount: number): AgentRunSummary {
  return {
    terminalStatus: 'completed',
    modelLoopCount,
    toolIterationCount: 0,
    requestedToolCallCount: 0,
    physicalRunStartIndex: 0,
    learningTrajectoryStartIndex: 0,
    historyEndIndex: 0,
    hasFinalResponse: true,
    waitingForInteraction: false,
  };
}

/** 构造最小 RunEnd HookContext。 */
function hookContext(
  context: SessionContext,
  runSummary: AgentRunSummary | undefined,
): HookContext {
  return {
    sessionContext: context,
    eventName: HookEventName.RunEnd,
    control: { action: 'continue' },
    runSummary,
  };
}

/** 生成不会触发压缩的零预算。 */
function zeroUsage() {
  return {
    total: 0,
    inputTotal: 0,
    system: 0,
    rules: 0,
    transient: 0,
    history: 0,
    tools: 0,
    outputReserve: 0,
    isEstimated: true,
  };
}
