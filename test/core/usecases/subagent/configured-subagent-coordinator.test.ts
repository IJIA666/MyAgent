/**
 * @fileoverview 配置型子代理提交点消费测试：maxTurns 冻结、plan 权限收窄（含 bypass 父会话）、
 * 模型解析（profile/inherit/未知报错）、未知类型清单，以及真实加载器→注册表→协调器的装配链。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { SubagentParentSession } from '../../../../src/ports/driving/SubagentExecutionPort.js';
import type { SubagentTranscriptStore } from '../../../../src/core/usecases/subagent/SubagentTranscriptStore.js';
import { SubagentCoordinator } from '../../../../src/core/usecases/subagent/SubagentCoordinator.js';
import { SubagentDefinitionRegistry } from '../../../../src/core/usecases/subagent/SubagentDefinitionRegistry.js';
import { AgentDefinitionLoader } from '../../../../src/core/usecases/subagent/AgentDefinitionLoader.js';
import type {
  SubagentRuntime,
  SubagentRuntimeTaskOptions,
  SubagentRuntimeTaskResult,
} from '../../../../src/core/usecases/subagent/SubagentRuntime.js';
import type { TaskManager, TaskManagerSubmitResult } from '../../../../src/core/usecases/subagent/TaskManager.js';
import type { TaskStateStore } from '../../../../src/core/usecases/subagent/TaskStateStore.js';
import { createMockAppConfig } from '../../../helpers/mock-factory.js';
import type { AppConfig } from '../../../../src/config/index.js';
import type { SessionContext } from '../../../../src/core/domain/context.js';
import { PermissionSessionState } from '../../../../src/core/domain/permissions/permission-session-state.js';
import type { PermissionMode } from '../../../../src/core/domain/permissions/permission-types.js';

/** 用真实权限状态构造指定模式的冻结快照，保证 fromSnapshot 消费完整字段。 */
function createPermissionSnapshot(mode: PermissionMode): ReturnType<PermissionSessionState['snapshot']> {
  const state = new PermissionSessionState();
  if (mode !== 'default') {
    state.applyUpdates([{ type: 'setMode', target: 'session', mode }]);
  }
  return state.snapshot();
}

/** 构造可编排的协调器测试夹具，支持注入定义注册表与父权限模式。 */
function createCoordinator(options: {
  forkEnabled?: boolean;
  parentMode?: string;
  hasSnapshot?: boolean;
  definitionRegistry?: SubagentDefinitionRegistry;
  submitResult?: TaskManagerSubmitResult;
} = {}) {
  const appConfig = createMockAppConfig({ workspace: mkdtempSync(join(tmpdir(), 'coordinator-configured-')) }) as AppConfig;
  const runTask = vi.fn(async (task: SubagentRuntimeTaskOptions): Promise<SubagentRuntimeTaskResult> => {
    void task;
    return {
      status: 'completed',
      agentId: 'a-any',
      output: '子代理完成',
      eventCount: 1,
    };
  });
  const runtime = { runTask } as unknown as SubagentRuntime;
  const submit = vi.fn(async (params: {
    execute: (signal: AbortSignal) => Promise<SubagentRuntimeTaskResult>;
  }): Promise<TaskManagerSubmitResult> => {
    if (options.submitResult) {
      return options.submitResult;
    }
    // 模拟任务管理器在后台运行：执行提交点捕获的 execute 回调，使冻结输入进入 runTask。
    await params.execute(new AbortController().signal);
    return { kind: 'async_launched', agentId: 'a-task', description: 'read child file' };
  });
  const taskManager = {
    submit,
    list: vi.fn(async () => []),
    get: vi.fn(async () => undefined),
    cancel: vi.fn(async () => ({ status: 'not_found' })),
    cancelAll: vi.fn(async () => undefined),
    cancelForeground: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    rebindSession: vi.fn(async () => undefined),
    setHooks: vi.fn(),
    markWaitingForApproval: vi.fn(async () => true),
    markRunning: vi.fn(async () => true),
  } as unknown as TaskManager;
  const taskStateStore = {
    markNotified: vi.fn(async () => true),
  } as unknown as TaskStateStore;
  const transcriptStore = {
    read: vi.fn(async () => undefined),
    updateStatus: vi.fn(async () => true),
  } as unknown as SubagentTranscriptStore;

  const parentSession = {
    getSessionId: () => 'parent-session',
    getPermissionSessionState: () => ({
      snapshot: () => createPermissionSnapshot((options.parentMode ?? 'default') as PermissionMode),
    }),
    getLatestModelRequestSnapshot: () => (options.hasSnapshot
      ? { model: 'test-model', messages: [{ role: 'user' as const, content: '父任务' }], tools: [] }
      : undefined),
    isGenerating: () => false,
    hasPendingInteraction: () => false,
    isMessageProtocolClosed: () => true,
    emit: vi.fn(),
    addNotification: vi.fn(),
  } as unknown as SubagentParentSession;
  const coordinator = new SubagentCoordinator({
    runtime,
    taskManager,
    taskStateStore,
    transcriptStore,
    appConfig,
    llmConfigProvider: () => appConfig.llm,
    forkEnabled: options.forkEnabled ?? false,
    definitionRegistry: options.definitionRegistry,
  });
  return { appConfig, coordinator, parentSession, runTask, taskManager };
}

describe('配置型子代理提交点消费', () => {
  it('定义 maxTurns 在提交点冻结并透传 maxIterations', async () => {
    const registry = new SubagentDefinitionRegistry();
    registry.register({
      type: 'reviewer',
      description: '评审子代理',
      contextPolicy: 'fresh',
      toolPolicyKey: 'freshForeground',
      buildSystemPrompt: () => '你是评审员',
      maxTurns: 5,
    });
    const { coordinator, parentSession, runTask } = createCoordinator({ definitionRegistry: registry });
    await coordinator.execute({ prompt: '评审代码', description: 'review project code', subagentType: 'reviewer', parentSession });
    const task = runTask.mock.calls[0][0];
    expect(task.maxIterations).toBe(5);
  });

  it('定义 permissionMode: plan 在提交点收窄权限快照（父 default）', async () => {
    const registry = new SubagentDefinitionRegistry();
    registry.register({
      type: 'reviewer',
      description: '评审子代理',
      contextPolicy: 'fresh',
      toolPolicyKey: 'freshForeground',
      buildSystemPrompt: () => '你是评审员',
      permissionMode: 'plan',
    });
    const { coordinator, parentSession, runTask } = createCoordinator({ definitionRegistry: registry });
    await coordinator.execute({ prompt: '评审代码', description: 'review project code', subagentType: 'reviewer', parentSession });
    const task = runTask.mock.calls[0][0];
    expect(task.permissionSnapshot.mode).toBe('plan');
  });

  it('父会话为 bypass 时 Explore 仍收窄为 plan', async () => {
    const registry = new SubagentDefinitionRegistry();
    const { coordinator, parentSession, runTask } = createCoordinator({
      parentMode: 'bypassPermissions',
      definitionRegistry: registry,
    });
    await coordinator.execute({ prompt: '搜索代码', description: 'explore codebase', subagentType: 'Explore', parentSession });
    const task = runTask.mock.calls[0][0];
    expect(task.permissionSnapshot.mode).toBe('plan');
  });

  it('未知模型 ID 在提交点返回校验错误且不提交任务', async () => {
    const { coordinator, parentSession, taskManager } = createCoordinator();
    const result = await coordinator.execute({
      prompt: '读取文件',
      description: 'read child file',
      model: 'haiku',
      parentSession,
    });
    expect(result).toMatchObject({ status: 'error', code: 'INVALID_SUBAGENT_MODEL' });
    expect(taskManager.submit).not.toHaveBeenCalled();
  });

  it('已注册 profile ID 通过 getModelConfig 构造冻结配置', async () => {
    vi.stubEnv('AGENT_LLM_API_KEY', 'test-key');
    try {
      const { coordinator, parentSession, runTask } = createCoordinator();
      await coordinator.execute({
        prompt: '读取文件',
        description: 'read child file',
        model: 'deepseek-v4-flash',
        parentSession,
      });
      const task = runTask.mock.calls[0][0];
      expect(task.llmConfig?.profile.id).toBe('deepseek-v4-flash');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('未知类型错误携带全部已注册类型清单', async () => {
    const { coordinator, parentSession, taskManager } = createCoordinator();
    const result = await coordinator.execute({
      prompt: '读取文件',
      description: 'read child file',
      subagentType: 'nope',
      parentSession,
    });
    expect(result).toMatchObject({ status: 'error', code: 'UNKNOWN_SUBAGENT_TYPE' });
    expect((result as { message?: string }).message ?? '').toContain('general-purpose');
    expect((result as { message?: string }).message ?? '').toContain('Explore');
    expect(taskManager.submit).not.toHaveBeenCalled();
  });

  it('隐式 exact-fork（模型省略类型）不受 env 与调用参数模型覆盖', async () => {
    vi.stubEnv('MYAGENT_SUBAGENT_MODEL', 'deepseek-v4-pro');
    try {
      const { appConfig, coordinator, parentSession, runTask } = createCoordinator({
        forkEnabled: true,
        hasSnapshot: true,
      });
      const result = await coordinator.execute({
        prompt: '读取文件',
        description: 'read child file',
        model: 'deepseek-v4-flash',
        parentSession,
      });
      expect(result.status).not.toBe('error');
      const task = runTask.mock.calls[0][0];
      // fork 始终继承提交点父模型配置，env 与调用参数一律忽略。
      expect(task.llmConfig?.profile.id).toBe(appConfig.llm.profile.id);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('装配链：真实加载器→注册表→协调器，定义字段全部生效', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-assembly-'));
    try {
      const agentsDir = join(root, '.myagent', 'agents');
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(join(agentsDir, 'reviewer.md'), [
        '---',
        'name: reviewer',
        'description: 代码评审',
        'tools: [readFile, grepSearch]',
        'model: deepseek-v4-flash',
        'maxTurns: 8',
        'permissionMode: plan',
        '---',
        '你是评审员，直接报告结论。',
      ].join('\n'), 'utf8');
      const loader = new AgentDefinitionLoader(
        join(root, 'user-agents'),
        agentsDir,
      );
      const registry = new SubagentDefinitionRegistry(false, loader);
      vi.stubEnv('AGENT_LLM_API_KEY', 'test-key');
      try {
        const { coordinator, parentSession, runTask } = createCoordinator({ definitionRegistry: registry });
        const result = await coordinator.execute({
          prompt: '评审这段代码',
          description: 'review project code',
          subagentType: 'reviewer',
          parentSession,
        });
        expect(result.status).not.toBe('error');
        const task = runTask.mock.calls[0][0];
        expect(task.agentType).toBe('reviewer');
        expect(task.maxIterations).toBe(8);
        expect(task.permissionSnapshot.mode).toBe('plan');
        expect(task.llmConfig?.profile.id).toBe('deepseek-v4-flash');
        // 定义级工具池编译为可见性谓词：只读名单成员可见。
        expect(task.definitionToolVisibility?.('readFile')).toBe(true);
        expect(task.definitionToolVisibility?.('writeFile')).toBe(false);
        // 自定义正文经定义构造器进入系统提示组装。
        expect(task.definitionSystemPromptBuilder?.({} as unknown as SessionContext)).toContain('你是评审员');
      } finally {
        vi.unstubAllEnvs();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
