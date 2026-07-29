/**
 * @file caller trust 与会话授权隔离集成测试。
 * 验证 remote 调用者不能凭复用 session id 借用本地规则，同时宿主验证的后台 caller
 * 可以继续接受其独立权限状态的 fail-closed 裁决。
 */

import { describe, expect, it } from 'vitest';
import { writeFileAdapter } from '../../src/adapters/tools/permissions/file-tool-authorization.js';
import { initWorkspace } from '../../src/adapters/tools/impl/base.js';
import { PermissionSessionState } from '../../src/core/domain/permissions/permission-session-state.js';
import { ToolPermissionService } from '../../src/core/domain/permissions/tool-permission-service.js';
import { createTrustedCallContext } from '../../src/core/domain/permissions/trusted-call-context.js';

describe('caller trust 隔离', () => {
  it('remote caller 即使复用本地 session id 也不能借用 session allow', async () => {
    initWorkspace(process.cwd());
    const state = new PermissionSessionState({ mode: 'default' });
    state.getRuleStore().addRule('session', {
      source: 'session',
      ruleBehavior: 'allow',
      ruleValue: { toolName: 'writeFile' },
    });
    const localCaller = createTrustedCallContext('same-session-id', 'interactive');
    const remoteCaller = createTrustedCallContext('same-session-id', 'remote');
    const service = new ToolPermissionService({ ruleStore: state.getRuleStore() });
    const request = writeFileAdapter.buildPermissionRequest(
      { targetPath: 'src/remote-reuse-probe.ts' },
      { caller: remoteCaller },
    );

    const localDecision = await service.checkRequest(request, state, { caller: localCaller });
    const remoteDecision = await service.checkRequest(request, state, { caller: remoteCaller });

    expect(localDecision.kind).toBe('allow');
    expect(remoteDecision).toMatchObject({
      kind: 'ask',
      decisionSource: 'invariant',
      overridable: false,
    });
  });

  it('宿主验证的 background caller 使用独立 dontAsk 状态时应 fail closed', async () => {
    const state = new PermissionSessionState({ mode: 'dontAsk' });
    const backgroundCaller = createTrustedCallContext(
      'auto-memory-agent',
      'background',
      '1.0.0',
      'subagent',
    );
    const service = new ToolPermissionService({ ruleStore: state.getRuleStore() });
    const request = writeFileAdapter.buildPermissionRequest(
      { targetPath: 'src/background-probe.ts' },
      { caller: backgroundCaller },
    );

    const decision = await service.checkRequest(request, state, {
      caller: backgroundCaller,
    });
    expect(decision).toMatchObject({
      kind: 'deny',
      decisionSource: 'mode',
      overridable: false,
    });
  });
});
