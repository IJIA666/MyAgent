/**
 * @file 正式资源证据与 Shell 适配器契约测试。
 * 验证既有 Shell AST 分析会进入 PermissionRequest、受保护网络上限和 ExecutionPlan，
 * 而不是退回基于工具名的旧兼容路径。
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { initWorkspace } from '../../../src/adapters/tools/impl/base.js';
import {
  BashTool,
  PowerShellTool,
} from '../../../src/adapters/tools/impl/system/terminal.js';
import { ToolCallGateway } from '../../../src/adapters/tools/ToolCallGateway.js';
import { PermissionSessionState } from '../../../src/core/domain/permissions/permission-session-state.js';
import { PermissionRuleStore } from '../../../src/core/domain/permissions/rule-store.js';
import { ToolPermissionService } from '../../../src/core/domain/permissions/tool-permission-service.js';
import { createTrustedCallContext } from '../../../src/core/domain/permissions/trusted-call-context.js';
import {
  createMcpArgumentsDigest,
  createMcpPermissionCandidate,
  createMcpToolAuthorizationAdapter,
} from '../../../src/adapters/tools/permissions/mcp-tool-authorization.js';

const caller = createTrustedCallContext('resource-evidence-test', 'interactive');

/** 返回当前平台可真实执行的 Shell 工具及只读命令。 */
function createPlatformShell(): {
  readonly tool: BashTool | PowerShellTool;
  readonly readCommand: string;
  readonly metadataCommand: string;
} {
  return process.platform === 'win32'
    ? {
        tool: new PowerShellTool(),
        readCommand: 'Get-Content package.json',
        metadataCommand: 'Invoke-WebRequest http://169.254.169.254/latest/meta-data/',
      }
    : {
        tool: new BashTool(),
        readCommand: 'cat package.json',
        metadataCommand: 'curl http://169.254.169.254/latest/meta-data/',
      };
}

describe('正式 Shell 资源证据', () => {
  beforeAll(() => {
    initWorkspace(process.cwd());
  });

  it('把工具专属分析投影为命令和规范文件证据', async () => {
    const { tool, readCommand } = createPlatformShell();
    const candidate = await tool.checkPermissions?.(
      { command: readCommand },
      { mode: 'default', rules: new PermissionRuleStore() },
    );
    const request = tool.authorizationAdapter?.buildPermissionRequest(
      { command: readCommand },
      { toolResult: candidate, caller },
    );

    expect(request).toBeDefined();
    expect(request?.permissionIdentity).toBe(
      process.platform === 'win32' ? 'ShellPowerShell' : 'ShellBash',
    );
    expect(request?.resourceEvidences).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'command',
        operation: 'execute',
        provenance: 'tool-analyzed',
        channelTrust: 'interactive',
      }),
      expect.objectContaining({
        kind: 'file',
        operation: 'read',
        provenance: 'tool-analyzed',
        channelTrust: 'interactive',
      }),
    ]));
  });

  it('分析缺失时产生显式 unknown，不能伪装成已验证资源', () => {
    const { tool, readCommand } = createPlatformShell();
    const request = tool.authorizationAdapter?.buildPermissionRequest(
      { command: readCommand },
      { caller },
    );

    expect(request?.resourceEvidences).toEqual([
      expect.objectContaining({
        kind: 'unknown',
        sourceNodeId: 'shell-analysis-missing',
        provenance: 'tool-analyzed',
      }),
    ]);
  });

  it('云元数据地址在普通规则和用户审批之前硬拒绝', async () => {
    const { tool, metadataCommand } = createPlatformShell();
    const state = new PermissionSessionState({ mode: 'default' });
    const candidate = await tool.checkPermissions?.(
      { command: metadataCommand },
      { mode: 'default', rules: state.getRuleStore() },
    );
    const request = tool.authorizationAdapter?.buildPermissionRequest(
      { command: metadataCommand },
      { toolResult: candidate, caller },
    );
    if (!request) throw new Error('Shell 工具缺少正式权限适配器');

    const decision = await new ToolPermissionService({
      ruleStore: state.getRuleStore(),
    }).checkRequest(request, state, { toolResult: candidate, caller });

    expect(request.resourceEvidences).toContainEqual(expect.objectContaining({
      kind: 'network',
      scope: 'cloud-metadata',
      protected: true,
    }));
    expect(decision).toMatchObject({
      kind: 'deny',
      decisionSource: 'invariant',
      overridable: false,
    });
  });

  it('Gateway 为真实 Shell 调用签发带身份和资源的 ExecutionPlan', async () => {
    const { tool } = createPlatformShell();
    const state = new PermissionSessionState({ mode: 'default' });
    const ruleStore = state.getRuleStore();
    const service = new ToolPermissionService({ ruleStore });
    const gateway = new ToolCallGateway(service, ruleStore);
    gateway.registerTools([tool]);
    const command = process.platform === 'win32' ? 'Get-Location' : 'pwd';

    const result = await gateway.execute(
      tool.name,
      { command },
      'default',
      { permissionState: state, caller },
    );

    expect(result.authorizedContext?.plan.permissionIdentity).toBe(
      process.platform === 'win32' ? 'ShellPowerShell' : 'ShellBash',
    );
    expect(result.authorizedContext?.plan.resourceEvidences).toContainEqual(
      expect.objectContaining({ kind: 'command', operation: 'execute' }),
    );
  });
});

describe('正式 MCP 资源证据', () => {
  it('readOnlyHint 只形成外部声明，仍必须精确单次确认', () => {
    const descriptor = {
      name: 'remote_read',
      serverName: 'untrusted-server',
      descriptorVersion: 'descriptor-v1',
      annotations: { readOnlyHint: true },
    };
    const candidate = createMcpPermissionCandidate(descriptor);
    const request = createMcpToolAuthorizationAdapter(descriptor).buildPermissionRequest(
      { z: 1, a: { y: 2, x: 3 } },
      { toolResult: candidate, caller },
    );

    expect(candidate).toMatchObject({
      kind: 'ask',
      decisionCode: 'mcp.external-claimed',
      ruleSuggestions: [],
      evidence: { sideEffect: 'unknown' },
    });
    expect(request.resourceEvidences).toEqual([
      expect.objectContaining({
        kind: 'mcp-call',
        serverName: 'untrusted-server',
        toolName: 'remote_read',
        descriptorVersion: 'descriptor-v1',
        provenance: 'external-claimed',
      }),
    ]);
    expect(request.approvalOptions).toEqual([
      { type: 'allowOnce' },
      { type: 'deny' },
    ]);
  });

  it('参数摘要与对象键顺序无关且不暴露原始参数', () => {
    const first = createMcpArgumentsDigest({ a: 1, nested: { x: 2, y: 3 } });
    const reordered = createMcpArgumentsDigest({ nested: { y: 3, x: 2 }, a: 1 });

    expect(first).toBe(reordered);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain('nested');
  });
});
