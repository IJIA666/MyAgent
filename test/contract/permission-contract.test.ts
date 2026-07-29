/**
 * @file 用户可见文件权限流程契约测试。
 * 覆盖 Manual 首问、Accept edits 切换、后续免问、范围外单次放行、
 * 显式目录组合动作和 protected path 硬上限。
 */

import { dirname, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ToolCatalog } from '../../src/adapters/tools/ToolCatalog.js';
import { ToolCallGateway } from '../../src/adapters/tools/ToolCallGateway.js';
import { ToolExecutor } from '../../src/adapters/tools/ToolExecutor.js';
import { initWorkspace } from '../../src/adapters/tools/impl/base.js';
import { writeFileAdapter } from '../../src/adapters/tools/permissions/file-tool-authorization.js';
import type { NativeTool } from '../../src/adapters/tools/tool-types.js';
import { PermissionSessionState } from '../../src/core/domain/permissions/permission-session-state.js';
import { ToolPermissionService } from '../../src/core/domain/permissions/tool-permission-service.js';
import { createTrustedCallContext } from '../../src/core/domain/permissions/trusted-call-context.js';
import { PermissionPromptAdapter } from '../../src/core/usecases/plugins/PermissionPromptAdapter.js';
import type { ApprovalAction } from '../../src/core/domain/permissions/permission-types.js';

/** 创建一个不落盘、但完整经过 Gateway 的 writeFile 测试运行时。 */
function createWriteRuntime(state: PermissionSessionState): {
  readonly gateway: ToolCallGateway;
  readonly executeSpy: ReturnType<typeof vi.fn>;
} {
  const executeSpy = vi.fn(() => 'ok');
  const tool: NativeTool = {
    name: 'writeFile',
    securityCategory: 'write',
    definition: { type: 'function', function: { name: 'writeFile' } },
    authorizationAdapter: writeFileAdapter,
    checkPermissions: () => ({
      kind: 'ask',
      message: '写入文件',
      decisionReason: '文件写入需要授权',
      evidence: {
        operationCategory: 'file-write',
        sideEffect: 'write',
        riskReason: '测试文件写入',
        resources: [],
      },
    }),
    execute: executeSpy,
  };
  const service = new ToolPermissionService({ ruleStore: state.getRuleStore() });
  const catalog = new ToolCatalog([tool]);
  const executor = new ToolExecutor(
    catalog,
    context => service.consumeAuthorizedContext(context),
  );
  const gateway = new ToolCallGateway(service, state.getRuleStore(), executor);
  gateway.registerTools([tool]);
  return { gateway, executeSpy };
}

/** 创建选择指定动作并记录实际动作列表的 prompt adapter。 */
function createPrompt(
  state: PermissionSessionState,
  actionId: ApprovalAction['type'],
  observedActions: ApprovalAction[][],
): PermissionPromptAdapter {
  return new PermissionPromptAdapter(state, async (_decision, _mode, _signal, actions) => {
    observedActions.push([...(actions ?? [])]);
    return { approved: actionId !== 'deny', actionId };
  });
}

describe('文件权限用户契约', () => {
  const caller = createTrustedCallContext('permission-contract', 'interactive');

  it('Manual 首问切换 Accept edits 后，同一会话工作区编辑应免问', async () => {
    initWorkspace(process.cwd());
    const state = new PermissionSessionState({ mode: 'default' });
    const { gateway, executeSpy } = createWriteRuntime(state);
    const observedActions: ApprovalAction[][] = [];
    const prompt = createPrompt(state, 'allowAndSetMode', observedActions);

    await gateway.execute('writeFile', { targetPath: 'src/first.ts' }, 'default', {
      permissionState: state,
      caller,
      promptAdapter: prompt,
    });
    await gateway.execute('writeFile', { targetPath: 'src/second.ts' }, state.getMode(), {
      permissionState: state,
      caller,
      promptAdapter: prompt,
    });

    expect(observedActions).toHaveLength(1);
    expect(observedActions[0].map(action => action.type)).toEqual([
      'allowOnce',
      'allowAndSetMode',
      'deny',
    ]);
    expect(state.getMode()).toBe('acceptEdits');
    expect(executeSpy).toHaveBeenCalledTimes(2);
  });

  it('范围外 Allow once 不得隐式增加目录或切换模式', async () => {
    initWorkspace(process.cwd());
    const state = new PermissionSessionState({ mode: 'default' });
    const { gateway } = createWriteRuntime(state);
    const externalTarget = resolve(process.cwd(), '..', 'allow-once', 'file.ts');
    const observedActions: ApprovalAction[][] = [];

    await gateway.execute('writeFile', { targetPath: externalTarget }, 'default', {
      permissionState: state,
      caller,
      promptAdapter: createPrompt(state, 'allowOnce', observedActions),
    });

    expect(state.getMode()).toBe('default');
    expect(state.getAdditionalDirectories()).toEqual([]);
  });

  it('范围外组合动作必须原子切换模式并加入明确目录', async () => {
    initWorkspace(process.cwd());
    const state = new PermissionSessionState({ mode: 'default' });
    const { gateway } = createWriteRuntime(state);
    const externalTarget = resolve(process.cwd(), '..', 'explicit-scope', 'file.ts');
    const observedActions: ApprovalAction[][] = [];

    await gateway.execute('writeFile', { targetPath: externalTarget }, 'default', {
      permissionState: state,
      caller,
      promptAdapter: createPrompt(
        state,
        'allowAndSetModeWithDirectories',
        observedActions,
      ),
    });

    expect(observedActions[0][1]).toMatchObject({
      type: 'allowAndSetModeWithDirectories',
      directories: [dirname(externalTarget)],
    });
    expect(state.getMode()).toBe('acceptEdits');
    expect(state.getAdditionalDirectories()).toEqual([dirname(externalTarget)]);
    expect(state.getStateVersion()).toBe(1);
  });

  it('protected path 不得进入审批，更不能由用户动作覆盖', async () => {
    initWorkspace(process.cwd());
    const state = new PermissionSessionState({ mode: 'acceptEdits' });
    const { gateway, executeSpy } = createWriteRuntime(state);
    const promptHandler = vi.fn(async () => ({
      approved: true,
      actionId: 'allowOnce' as const,
    }));

    await expect(gateway.execute('writeFile', { targetPath: '.git/config' }, state.getMode(), {
      permissionState: state,
      caller,
      promptAdapter: new PermissionPromptAdapter(state, promptHandler),
    })).rejects.toMatchObject({
      code: 'permission_denied_before_execution',
      executionStarted: false,
    });
    expect(promptHandler).not.toHaveBeenCalled();
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('审批处理器失败必须产生未执行的稳定生命周期错误', async () => {
    initWorkspace(process.cwd());
    const state = new PermissionSessionState({ mode: 'default' });
    const { gateway, executeSpy } = createWriteRuntime(state);
    const prompt = new PermissionPromptAdapter(state, async () => {
      throw new Error('UI unavailable');
    });

    await expect(gateway.execute('writeFile', { targetPath: 'src/failure.ts' }, 'default', {
      permissionState: state,
      caller,
      promptAdapter: prompt,
    })).rejects.toMatchObject({
      code: 'approval_handler_failed_before_execution',
      executionStarted: false,
    });
    expect(executeSpy).not.toHaveBeenCalled();
    expect(state.getStateVersion()).toBe(0);
  });
});
