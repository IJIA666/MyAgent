/**
 * @fileoverview 真实会话装配下的同步 Agent 子代理集成测试。
 * 使用临时工作区与可编排 Fake LLM，验证父循环、工具网关、子运行器和 transcript 的真实边界。
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createApplicationPaths } from '../../src/config/application-paths.js';
import { createMockAppConfig } from '../helpers/mock-factory.js';
import { initWorkspace } from '../../src/adapters/tools/impl/base.js';
import { ToolRegistry } from '../../src/adapters/tools/toolRegistry.js';
import { DefaultContextAdapter } from '../../src/adapters/context/DefaultContextAdapter.js';
import { TiktokenEstimator } from '../../src/adapters/llm/TiktokenEstimator.js';
import { SessionContext } from '../../src/core/domain/context.js';
import { SessionManager } from '../../src/core/usecases/engine/session.js';
import { SubagentExecutionController } from '../../src/core/usecases/subagent/SubagentExecutionController.js';
import { SubagentTranscriptStore } from '../../src/core/usecases/subagent/SubagentTranscriptStore.js';
import type { LlmConfig } from '../../src/config/index.js';
import type {
  ChatMessage,
  LlmPort,
  LlmPortOptions,
  LlmStreamEvent,
} from '../../src/ports/driven/llm/LlmPort.js';
import type { LlmClientFactoryPort } from '../../src/ports/driven/llm/LlmClientFactoryPort.js';

type ChildMode = 'read' | 'write' | 'delayed-complete';

/** 父循环第一次 Agent 调用的可编排形态。 */
type ParentAgentMode = 'sync' | 'background' | 'fork-omitted';

let tempRoot: string | undefined;

/** 可记录父子请求并按角色生成确定响应的 Fake LLM。 */
class IntegrationLlm implements LlmPort {
  public readonly requests: Array<{ messages: ChatMessage[]; tools: Record<string, unknown>[] }> = [];
  public aborted = false;
  private callCount = 0;

  /**
   * @param role - 父循环或子循环
   * @param childMode - 子循环的工具/延迟行为
   * @param parentAgentMode - 父循环第一次 Agent 调用的编排形态
   */
  constructor(
    private readonly role: 'parent' | 'child',
    private readonly childMode: ChildMode = 'read',
    private readonly parentAgentMode: ParentAgentMode = 'sync',
  ) {}

  /** @returns 稳定的测试模型名称 */
  public getModelName(): string {
    return this.role === 'parent' ? 'integration-parent' : 'integration-child';
  }

  /** 测试驱动不支持切换模型。 */
  public switchModel(_config: LlmConfig): void {
    // 子代理隔离测试只验证调用时快照，不在 Fake 中实现模型切换。
  }

  /** 记录父/子驱动是否在会话清理时被中止。 */
  public abort(): void {
    this.aborted = true;
  }

  /** 生成一次父 Agent 调用或子代理工具调用。 */
  public async *streamChat(
    messages: ChatMessage[],
    tools: Record<string, unknown>[],
    options?: LlmPortOptions,
  ): AsyncGenerator<LlmStreamEvent, void, unknown> {
    this.requests.push({
      messages: structuredClone(messages),
      tools: structuredClone(tools),
    });
    this.callCount++;
    if (options?.signal?.aborted) {
      throw createAbortError();
    }

    if (this.role === 'parent') {
      if (this.callCount === 1) {
        const agentArguments = buildParentAgentArguments(this.parentAgentMode);
        yield {
          type: 'tool_calls',
          toolCalls: [{
            id: 'parent-agent-call',
            type: 'function',
            function: { name: 'Agent', arguments: agentArguments },
          }],
          assistantMessage: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'parent-agent-call',
              type: 'function',
              function: { name: 'Agent', arguments: agentArguments },
            }],
          },
        };
        return;
      }
      yield {
        type: 'complete',
        content: '父循环完成',
        reasoning: '',
        assistantMessage: { role: 'assistant', content: '父循环完成' },
      };
      return;
    }

    if (this.childMode === 'delayed-complete') {
      await delay(35);
      if (options?.signal?.aborted) {
        throw createAbortError();
      }
      yield {
        type: 'complete',
        content: '延迟子代理完成',
        reasoning: '',
        assistantMessage: { role: 'assistant', content: '延迟子代理完成' },
      };
      return;
    }

    if (this.callCount === 1) {
      const functionName = this.childMode === 'write' ? 'writeFile' : 'readFile';
      const argumentsValue = this.childMode === 'write'
        ? { targetPath: 'child-output.txt', content: 'child write' }
        : { targetPath: 'child.txt', includeMetadata: true };
      yield {
        type: 'tool_calls',
        toolCalls: [{
          id: 'child-tool-call',
          type: 'function',
          function: { name: functionName, arguments: JSON.stringify(argumentsValue) },
        }],
        assistantMessage: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'child-tool-call',
            type: 'function',
            function: { name: functionName, arguments: JSON.stringify(argumentsValue) },
          }],
        },
      };
      return;
    }

    yield {
      type: 'complete',
      content: '子代理完成',
      reasoning: '',
      assistantMessage: { role: 'assistant', content: '子代理完成' },
    };
  }

  /** @returns 测试用非流式响应 */
  public async chat(): Promise<string> {
    return 'integration response';
  }

  /** @returns 测试用摘要响应 */
  public async generateSummaryAsync(): Promise<string> {
    return 'integration summary';
  }
}

/** 为每次子代理执行创建独立 Fake LLM，并保留冻结配置快照。 */
class IntegrationLlmFactory implements LlmClientFactoryPort {
  public readonly clients: IntegrationLlm[] = [];
  public readonly configs: LlmConfig[] = [];

  /**
   * @param childMode - 子循环的确定性行为
   */
  constructor(private readonly childMode: ChildMode) {}

  /** 创建与父驱动状态无关的新子客户端。 */
  public create(config: LlmConfig): LlmPort {
    this.configs.push(config);
    const client = new IntegrationLlm('child', this.childMode);
    this.clients.push(client);
    return client;
  }
}

/** 构造父循环第一次 Agent 调用参数。 */
function buildParentAgentArguments(mode: ParentAgentMode): string {
  if (mode === 'background') {
    return JSON.stringify({
      description: 'read child file',
      prompt: '读取 child.txt',
      run_in_background: true,
    });
  }
  if (mode === 'fork-omitted') {
    return JSON.stringify({ description: 'fork child task', prompt: 'fork 分支处理 child.txt' });
  }
  return JSON.stringify({ description: 'read child file', prompt: '读取 child.txt' });
}

describe('同步 Agent 子代理生产装配', () => {
  afterEach(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  it('父模型调用 Agent 后，子模型可调用普通工具且历史、transcript、父注册表保持隔离', async () => {
    const fixture = createFixture('read');
    const events: Array<{ type: string; message?: string }> = [];
    try {
      await fixture.session.open();
      fixture.session.on('agent_event', event => events.push(event as { type: string; message?: string }));
      fixture.session.handleUserInput('父任务不能进入子上下文');
      await waitForComplete(events);

      expect(fixture.parentLlm.requests).toHaveLength(2);
      expect(fixture.factory.clients).toHaveLength(1);
      const childLlm = fixture.factory.clients[0];
      const childToolNames = childLlm.requests[0].tools.map(getToolDefinitionName);
      expect(childToolNames).toContain('readFile');
      expect(childToolNames).not.toContain('Agent');
      expect(JSON.stringify(childLlm.requests[0].messages)).not.toContain('父任务不能进入子上下文');

      const parentHistory = fixture.session.getHistory();
      // 子代理最终文本只应作为 Agent 工具结果存在，不能伪装成父循环的 assistant 消息。
      expect(parentHistory
        .filter(message => message.role === 'assistant')
        .map(message => message.content)).not.toContain('子代理完成');
      const toolMessage = parentHistory.find(message => message.role === 'tool');
      expect(toolMessage?.content).toContain('子代理完成');
      const toolEnvelope = JSON.parse(toolMessage?.content ?? '{}') as {
        content?: Array<{ text?: string }>;
      };
      const agentResult = JSON.parse(toolEnvelope.content?.[0]?.text ?? '{}') as {
        status?: string;
        agentId?: string;
      };
      expect(agentResult.status).toBe('completed');
      expect(agentResult.agentId).toEqual(expect.any(String));

      const transcript = await new SubagentTranscriptStore(fixture.paths.subagentsDir)
        .read(fixture.session.getSessionId(), agentResult.agentId!);
      expect(transcript?.status).toBe('completed');
      expect(transcript?.contextPolicy).toBe('fresh');
      expect(transcript?.messages.some(message => message.content === '父任务不能进入子上下文')).toBe(false);

      // 子作用域关闭后，父注册表仍可执行普通读取工具。
      const checkContext = new SessionContext('parent-registry-check');
      checkContext.appConfig = fixture.appConfig;
      const parentOutcome = await fixture.registry.callTool(
        'readFile',
        { targetPath: 'child.txt', includeMetadata: true },
        checkContext,
      );
      expect(JSON.stringify(parentOutcome.value)).toContain('parent-visible-file');
    } finally {
      await fixture.session.close();
    }
  });

  it('父 plan 模式阻断子写入，且子循环超过普通工具超时仍可完成', async () => {
    const planFixture = createFixture('write');
    try {
      await planFixture.session.open();
      planFixture.session.setPermissionMode('plan');
      const planEvents: Array<{ type: string; message?: string }> = [];
      planFixture.session.on('agent_event', event => planEvents.push(event as { type: string; message?: string }));
      planFixture.session.handleUserInput('plan 模式下不得写入');
      await waitForComplete(planEvents);

      const childRequestAfterTool = planFixture.factory.clients[0].requests[1];
      const childToolResult = childRequestAfterTool.messages.find(message => message.role === 'tool');
      expect(childToolResult?.content).toMatch(/拒绝|plan|权限/iu);
      expect(readWorkspaceFile(planFixture.workspace, 'child-output.txt')).toBeUndefined();
    } finally {
      await planFixture.session.close();
    }

    const timeoutFixture = createFixture('delayed-complete', { toolTimeoutMs: 5 });
    try {
      await timeoutFixture.session.open();
      const timeoutEvents: Array<{ type: string; message?: string }> = [];
      timeoutFixture.session.on('agent_event', event => timeoutEvents.push(event as { type: string; message?: string }));
      timeoutFixture.session.handleUserInput('Agent 不应被普通工具总超时截断');
      await waitForComplete(timeoutEvents);
      const toolMessage = timeoutFixture.session.getHistory().find(message => message.role === 'tool');
      expect(toolMessage?.content).toContain('completed');
      expect(toolMessage?.content).toContain('延迟子代理完成');
    } finally {
      await timeoutFixture.session.close();
    }
  });

  it('default 审批只更新子权限状态，父会话后续写入仍需独立审批', async () => {
    const fixture = createFixture('write');
    const approvals: Array<{ name: string; choices: readonly string[] }> = [];
    try {
      await fixture.session.open();
      const parentSnapshot = fixture.session.getPermissionSnapshot();
      fixture.session.approvalInteraction.registerApprovalHandler((id, toolCall, _prefix, _message, choices) => {
        approvals.push({
          name: toolCall.name,
          choices: choices?.map(choice => choice.choiceId) ?? [],
        });
        const action = approvals.length === 1 ? 'allowAndSetMode' : 'allowOnce';
        fixture.session.approvalInteraction.resolve(id, { action });
      });

      const events: Array<{ type: string; message?: string }> = [];
      fixture.session.on('agent_event', event => events.push(event as { type: string; message?: string }));
      fixture.session.handleUserInput('default 模式下由子代理申请一次编辑授权');
      await waitForComplete(events);

      expect(approvals[0]).toMatchObject({ name: 'writeFile' });
      expect(approvals[0].choices).toContain('allowAndSetMode');
      expect(readWorkspaceFile(fixture.workspace, 'child-output.txt')).toBe('child write');
      expect(fixture.session.getPermissionSnapshot()).toEqual(parentSnapshot);

      await fixture.registry.callTool(
        'writeFile',
        { targetPath: 'parent-output.txt', content: 'parent write' },
        fixture.session.getContext(),
      );
      expect(approvals).toHaveLength(2);
      expect(approvals[1]).toMatchObject({ name: 'writeFile' });
      expect(readWorkspaceFile(fixture.workspace, 'parent-output.txt')).toBe('parent write');
      expect(fixture.session.getPermissionSnapshot()).toEqual(parentSnapshot);
    } finally {
      await fixture.session.close();
    }
  });

  it('父会话 abort 会物理取消在途子模型并写入 cancelled transcript', async () => {
    const fixture = createFixture('delayed-complete');
    try {
      await fixture.session.open();
      fixture.session.handleUserInput('启动一个等待中的子代理');
      await waitUntil(() => fixture.factory.clients[0]?.requests.length > 0);

      fixture.session.abort();
      await waitUntil(() => fixture.factory.clients[0]?.aborted === true);

      const transcript = await waitForTranscript(fixture.paths.subagentsDir, 'killed');
      expect(transcript.status).toBe('killed');
    } finally {
      await fixture.session.close();
    }
  });

  it('后台 Agent 立即返回 async_launched，完成后以 task-notification 交付且父历史不含子内部消息', async () => {
    const fixture = createFixture('read', { parentAgentMode: 'background' });
    try {
      await fixture.session.open();
      const events: Array<{ type: string; message?: string }> = [];
      fixture.session.on('agent_event', event => events.push(event as { type: string; message?: string }));
      fixture.session.handleUserInput('启动后台子代理');
      await waitForComplete(events);

      // 父循环在子代理未完成时就已结束，Agent 工具结果为 async_launched。
      const toolMessage = fixture.session.getHistory().find(message => message.role === 'tool');
      const agentResult = JSON.parse(extractToolText(toolMessage?.content)) as { status?: string; agentId?: string };
      expect(agentResult.status).toBe('async_launched');
      expect(agentResult.agentId).toEqual(expect.any(String));

      // 后台任务随后完成，扫描结果通过通知进入父历史。
      await waitUntil(() => findTaskNotification(fixture.session.getHistory()) !== undefined);
      const notification = findTaskNotification(fixture.session.getHistory())!;
      expect(notification).toContain('completed');
      expect(notification).toContain('子代理完成');
      // 父历史不得出现子代理的中间请求。
      expect(JSON.stringify(fixture.session.getHistory())).not.toContain('child-tool-call');
    } finally {
      await fixture.session.close();
    }
  });

  it('前台子代理超过 subagentAutoBackgroundMs 后自动转为后台', async () => {
    const fixture = createFixture('delayed-complete', {
      autoBackgroundMs: 10,
    });
    try {
      await fixture.session.open();
      const events: Array<{ type: string; message?: string }> = [];
      fixture.session.on('agent_event', event => events.push(event as { type: string; message?: string }));
      fixture.session.handleUserInput('前台任务应超时转后台');
      await waitForComplete(events);

      const toolMessage = fixture.session.getHistory().find(message => message.role === 'tool');
      const agentResult = JSON.parse(extractToolText(toolMessage?.content)) as { status?: string };
      expect(agentResult.status).toBe('async_launched');
      await waitUntil(() => findTaskNotification(fixture.session.getHistory()) !== undefined);
      expect(findTaskNotification(fixture.session.getHistory())).toContain('延迟子代理完成');
    } finally {
      await fixture.session.close();
    }
  });

  it('fork 开关开启时模型省略 subagent_type 即隐式 fork，快照包含父历史与占位闭合', async () => {
    const fixture = createFixture('read', {
      parentAgentMode: 'fork-omitted',
      forkEnabled: true,
    });
    try {
      await fixture.session.open();
      const events: Array<{ type: string; message?: string }> = [];
      fixture.session.on('agent_event', event => events.push(event as { type: string; message?: string }));
      fixture.session.handleUserInput('父任务不能进入子上下文');
      await waitForComplete(events);

      // fork 强制后台，Agent 工具返回 async_launched。
      const toolMessage = fixture.session.getHistory().find(message => message.role === 'tool');
      const agentResult = JSON.parse(extractToolText(toolMessage?.content)) as { status?: string };
      expect(agentResult.status).toBe('async_launched');

      // 子代理消息前缀来自父最终请求快照：包含父 system、记忆投影与父 user 历史；
      // 触发 fork 的当前 assistant 调用追加到末尾并占位闭合，最后是带分支指令的任务消息。
      const childRequest = await waitForChildRequest(fixture, 0);
      const childMessages = childRequest.messages;
      expect(childMessages[0]?.content).toContain('你是 MyAgent');
      expect(childMessages.some(message =>
        typeof message.content === 'string' && message.content.startsWith('父任务不能进入子上下文'))).toBe(true);
      expect(childMessages.some(message =>
        message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0
        && message.tool_calls?.[0]?.function.name === 'Agent')).toBe(true);
      expect(childMessages.some(message =>
        message.role === 'tool' && message.content === '[exact-fork tool result unavailable]')).toBe(true);
      expect(childMessages.some(message =>
        typeof message.content === 'string' && message.content.includes('fork 分支处理 child.txt'))).toBe(true);

      await waitUntil(() => findTaskNotification(fixture.session.getHistory()) !== undefined);
      expect(findTaskNotification(fixture.session.getHistory())).toContain('子代理完成');
    } finally {
      await fixture.session.close();
    }
  });

  it('/subtask 从空闲闭合会话创建后台 exact-fork', async () => {
    const fixture = createFixture('read');
    try {
      await fixture.session.open();
      const events: Array<{ type: string; message?: string }> = [];
      fixture.session.on('agent_event', event => events.push(event as { type: string; message?: string }));
      // 先跑一次父循环产生最终请求快照。
      fixture.session.handleUserInput('为 subtask 生成请求快照');
      await waitForComplete(events);

      const result = await fixture.session.startSubtask('继续处理 child.txt 并报告结果', 'continue child task');
      expect(result.status).toBe('async_launched');
      if (result.status !== 'async_launched') return;
      expect(result.agentId).toEqual(expect.any(String));

      // 空闲且协议闭合时快照不含未闭合工具调用，子请求包含父历史、分支指令与 fork 任务消息。
      // 父循环先创建了一个同步子代理（clients[0]），fork 任务是第二个客户端（clients[1]）。
      const childRequest = await waitForChildRequest(fixture, 1);
      const childMessages = childRequest.messages;
      expect(childMessages.some(message =>
        typeof message.content === 'string' && message.content.startsWith('为 subtask 生成请求快照'))).toBe(true);
      expect(childMessages.some(message =>
        typeof message.content === 'string' && message.content.includes('你是分支工作代理'))).toBe(true);
      expect(childMessages.some(message =>
        typeof message.content === 'string' && message.content.includes('继续处理 child.txt 并报告结果'))).toBe(true);

      // 任务可通过任务控制面查询到。
      const tasks = await fixture.session.listAgentTasks();
      expect(tasks.some(task => task.agentId === result.agentId)).toBe(true);
      await waitUntil(() => findTaskNotification(fixture.session.getHistory()) !== undefined);
    } finally {
      await fixture.session.close();
    }
  });

  it('普通 abort 不取消已接受的后台任务，任务仍完成并通知', async () => {
    const fixture = createFixture('delayed-complete', {
      parentAgentMode: 'background',
    });
    try {
      await fixture.session.open();
      const events: Array<{ type: string; message?: string }> = [];
      fixture.session.on('agent_event', event => events.push(event as { type: string; message?: string }));
      fixture.session.handleUserInput('启动后台慢任务');
      await waitUntil(() => fixture.factory.clients[0]?.requests.length > 0);

      fixture.session.abort();
      // 后台任务与父取消解绑，abort 后仍继续执行并完成通知；
      // 子驱动在任务终态时由运行器正常释放（aborted 标志表示释放而非取消）。
      await waitUntil(() => findTaskNotification(fixture.session.getHistory()) !== undefined);
      expect(findTaskNotification(fixture.session.getHistory())).toContain('延迟子代理完成');
      expect(fixture.factory.clients[0].requests.length).toBeGreaterThan(0);
    } finally {
      await fixture.session.close();
    }
  });

  it('小并发下后台任务排队，超过在途上限后稳定拒绝', async () => {
    const fixture = createFixture('delayed-complete', {
      maxConcurrent: 1,
      maxInFlight: 2,
    });
    try {
      await fixture.session.open();
      const events: Array<{ type: string; message?: string }> = [];
      fixture.session.on('agent_event', event => events.push(event as { type: string; message?: string }));
      fixture.session.handleUserInput('为任务队列生成请求快照');
      await waitForComplete(events);

      const first = await fixture.session.startSubtask('第一个后台任务', 'first background task');
      expect(first.status).toBe('async_launched');
      const second = await fixture.session.startSubtask('第二个后台任务', 'second background task');
      expect(second.status).toBe('async_launched');
      const third = await fixture.session.startSubtask('第三个后台任务', 'third background task');
      expect(third.status).toBe('error');
      if (third.status !== 'error') return;
      expect(third.code).toBe('SUBAGENT_CAPACITY_EXCEEDED');

      // 排队任务与运行任务在任务列表中可见，且不泄露 prompt。
      const tasks = await fixture.session.listAgentTasks();
      const summaries = JSON.stringify(tasks);
      expect(summaries).toContain('first background task');
      expect(summaries).not.toContain('第一个后台任务');
      expect(tasks.some(task => task.status === 'pending')).toBe(true);
    } finally {
      await fixture.session.close();
    }
  });
});

/** 创建临时工作区、真实 ToolRegistry、SessionManager 和 Agent 绑定控制器。 */
function createFixture(
  childMode: ChildMode,
  options: {
    toolTimeoutMs?: number;
    parentAgentMode?: ParentAgentMode;
    forkEnabled?: boolean;
    autoBackgroundMs?: number;
    maxConcurrent?: number;
    maxInFlight?: number;
  } = {},
) {
  tempRoot = mkdtempSync(join(tmpdir(), 'subagent-integration-'));
  const workspace = join(tempRoot, 'workspace');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'child.txt'), 'parent-visible-file', 'utf8');
  const paths = createApplicationPaths(workspace, {
    appDataRoot: join(tempRoot, 'app-data'),
  });
  initWorkspace(workspace, undefined, 'default', paths.memoryDir);
  const appConfig = createMockAppConfig({
    workspace,
    applicationPaths: paths,
  });
  appConfig.runtimeLimits = {
    ...appConfig.runtimeLimits,
    maxIterations: 4,
    toolTimeoutMs: options.toolTimeoutMs ?? 30000,
    modelTimeoutMs: 1000,
    subagentMaxConcurrent: options.maxConcurrent ?? 4,
    subagentMaxInFlight: options.maxInFlight ?? 16,
    subagentAutoBackgroundMs: options.autoBackgroundMs ?? 0,
    subagentForkEnabled: options.forkEnabled ?? false,
  };
  const controller = new SubagentExecutionController();
  const registry = new ToolRegistry(undefined, { subagentExecutionPort: controller });
  const parentLlm = new IntegrationLlm('parent', 'read', options.parentAgentMode ?? 'sync');
  const factory = new IntegrationLlmFactory(childMode);
  const estimator = new TiktokenEstimator();
  const session = new SessionManager(
    appConfig.llm,
    parentLlm,
    estimator,
    registry,
    new DefaultContextAdapter(estimator),
    appConfig,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    controller,
    factory,
  );
  return {
    appConfig,
    factory,
    parentLlm,
    paths,
    registry,
    session,
    workspace,
  };
}

/** 在父历史中查找最近一次后台任务通知。 */
function findTaskNotification(history: readonly ChatMessage[]): string | undefined {
  for (let index = history.length - 1; index >= 0; index--) {
    const content = history[index].content;
    if (typeof content === 'string' && content.includes('<task-notification>')) {
      return content;
    }
  }
  return undefined;
}

/** 等待真实 SessionManager 发出本轮唯一 complete 事件。 */
async function waitForComplete(events: Array<{ type: string }>): Promise<void> {
  const started = Date.now();
  while (!events.some(event => event.type === 'complete')) {
    if (Date.now() - started > 5000) {
      throw new Error(`等待 SessionManager 完成超时，事件: ${JSON.stringify(events)}`);
    }
    await delay(10);
  }
}

/** 在限定时间内等待可观察条件成立。 */
async function waitUntil(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 5000) {
      throw new Error('等待子代理状态超时');
    }
    await delay(5);
  }
}

/** 等待并读取本次临时目录中唯一的子代理 transcript。 */
async function waitForTranscript(
  subagentsDir: string,
  expectedStatus = 'cancelled',
): Promise<{ status?: string }> {
  let transcriptPath: string | undefined;
  await waitUntil(() => {
    transcriptPath = findTranscript(subagentsDir);
    if (!transcriptPath) {
      return false;
    }
    const parsed = JSON.parse(readFileSync(transcriptPath, 'utf8')) as { status?: string };
    return parsed.status === expectedStatus;
  });
  return JSON.parse(readFileSync(transcriptPath!, 'utf8')) as { status?: string };
}

/** 递归定位隔离目录中的 transcript.json。 */
function findTranscript(directory: string): string | undefined {
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = findTranscript(path);
      if (nested) return nested;
    } else if (entry.name === 'transcript.json') {
      return path;
    }
  }
  return undefined;
}

/** 读取测试工作区中的文件，不把“不存在”转换成测试异常。 */
function readWorkspaceFile(workspace: string, name: string): string | undefined {
  try {
    return readFileSync(join(workspace, name), 'utf8');
  } catch {
    return undefined;
  }
}

/** 从 OpenAI function 定义中读取名称。 */
function getToolDefinitionName(tool: Record<string, unknown>): string {
  const fn = tool.function as { name?: unknown } | undefined;
  return typeof fn?.name === 'string' ? fn.name : String(tool.name ?? '');
}

/** 提取工具结果正文中的文本字段。 */
function extractToolText(content: unknown): string {
  const envelope = JSON.parse(typeof content === 'string' ? content : '{}') as {
    content?: Array<{ text?: string }>;
  };
  return envelope.content?.[0]?.text ?? '';
}

/** 等待子代理工厂产生第 N 个客户端的首次请求。 */
async function waitForChildRequest(
  fixture: ReturnType<typeof createFixture>,
  clientIndex: number,
): Promise<{ messages: ChatMessage[] }> {
  let client: IntegrationLlm | undefined;
  await waitUntil(() => {
    client = fixture.factory.clients[clientIndex];
    return client !== undefined && client.requests.length > 0;
  });
  return client!.requests[0];
}

/** 延迟一小段时间，给取消和外层超时测试提供可观察窗口。 */
function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/** 创建符合 LLM 端口约定的取消异常。 */
function createAbortError(): Error {
  const error = new Error('integration fake model aborted');
  error.name = 'AbortError';
  return error;
}
