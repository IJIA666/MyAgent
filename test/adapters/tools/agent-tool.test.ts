/**
 * @fileoverview 验证 Agent 工具的第一阶段 schema、参数边界和结构化结果。
 */

import { describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../../../src/core/domain/context.js';
import { createTrustedCallContext } from '../../../src/core/domain/permissions/trusted-call-context.js';
import { AgentTool } from '../../../src/adapters/tools/impl/agent/AgentTool.js';
import { SUBAGENT_ERROR_CODES } from '../../../src/ports/driving/SubagentExecutionPort.js';
import type { ToolExecutionContext } from '../../../src/core/usecases/plugins/plugin-types.js';

describe('AgentTool', () => {
  it('schema 包含阶段内四个字段，并使用 parent-signal', () => {
    const tool = new AgentTool();
    const parameters = (tool.definition.function as { parameters: {
      properties: Record<string, unknown>;
      required: string[];
    } }).parameters;

    expect(tool.name).toBe('Agent');
    expect(tool.executionTimeoutPolicy).toBe('parent-signal');
    expect(Object.keys(parameters.properties)).toEqual([
      'description',
      'prompt',
      'subagent_type',
      'run_in_background',
    ]);
    expect(parameters.required).toEqual(['description', 'prompt']);
    expect(tool.subagentToolPolicy).toEqual({
      freshForeground: false,
      freshBackground: false,
      fork: false,
    });
  });

  it('校验参数、默认类型并传递父 session/caller/审批端口', async () => {
    const execute = vi.fn(async () => ({
      status: 'completed' as const,
      agentId: 'agent-1',
      output: 'done',
    }));
    const tool = new AgentTool({ execute });
    const session = new SessionContext('parent-session');
    const approvalPort = { waitApproval: vi.fn() };
    const interactionPort = { askUser: vi.fn(async () => ({})) };
    const caller = createTrustedCallContext('parent-caller');
    const signal = new AbortController().signal;

    expect(JSON.parse(await tool.execute({ description: 'read project file', prompt: '   ' }))).toMatchObject({
      status: 'error',
      code: 'INVALID_PROMPT',
    });
    expect(JSON.parse(await tool.execute({ description: 'read project file', prompt: 'task', subagent_type: 3 }))).toMatchObject({
      status: 'error',
      code: 'UNKNOWN_SUBAGENT_TYPE',
    });

    const value = JSON.parse(await tool.execute(
      { description: 'read project file', prompt: 'task' },
      {
        sessionContext: session,
        approvalPort,
        interactionPort,
        caller,
      } as unknown as ToolExecutionContext,
      signal,
    ));
    expect(value).toEqual({ status: 'completed', agentId: 'agent-1', output: 'done' });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'task',
      description: 'read project file',
      subagentType: undefined,
      runInBackground: false,
      parentSession: session,
      parentApprovalPort: approvalPort,
      interactionPort,
      signal,
      parentCaller: caller,
    }));
  });

  it('未绑定和执行异常都 fail-closed 为稳定 JSON', async () => {
    const session = new SessionContext('parent-session');
    const unbound = JSON.parse(await new AgentTool().execute(
      { description: 'read project file', prompt: 'task' },
      { sessionContext: session } as unknown as ToolExecutionContext,
    ));
    expect(unbound).toMatchObject({
      status: 'error',
      code: SUBAGENT_ERROR_CODES.notBound,
    });

    const failing = new AgentTool({ execute: vi.fn(async () => { throw new Error('internal'); }) });
    const result = JSON.parse(await failing.execute(
      { description: 'read project file', prompt: 'task' },
      { sessionContext: session } as unknown as ToolExecutionContext,
    ));
    expect(result).toMatchObject({
      status: 'error',
      code: SUBAGENT_ERROR_CODES.executionFailed,
    });
  });
});
