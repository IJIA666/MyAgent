/**
 * @fileoverview 工具调用编排合约测试。
 * 使用真实 ToolRegistry、PluginRegistry、ToolDispatcher、ApprovalEffectApplier
 * 和 ToolCallOrchestrator 装配完整工具编排管线，验证 pass/deny/suspend 路径。
 */

import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ToolRegistry } from '../../src/adapters/tools/toolRegistry.js';
import { PluginRegistry } from '../../src/core/usecases/plugins/plugin-registry.js';
import { HumanApprovalPlugin } from '../../src/core/usecases/plugins/HumanApprovalPlugin.js';
import { TracerLogPlugin } from '../../src/core/usecases/plugins/TracerLogPlugin.js';
import { ApprovalPolicy } from '../../src/core/usecases/security/ApprovalPolicy.js';
import { ToolCallOrchestrator } from '../../src/core/usecases/engine/tool-call-orchestrator.js';
import { ToolDispatcher } from '../../src/core/usecases/engine/ToolDispatcher.js';
import { ApprovalEffectApplier } from '../../src/core/usecases/engine/approval-effect-applier.js';
import { SessionContext } from '../../src/core/domain/context.js';
import { AgentTracer } from '../../src/core/domain/tracer.js';
import type { ToolPolicyPort } from '../../src/ports/shared/tool-policy.js';

/** 预设返回 pass 的策略端口 */
const passPolicy: ToolPolicyPort = { evaluate: async () => ({ status: 'pass' as const }) };

/** 预设返回 deny 的策略端口 */
const denyPolicy: ToolPolicyPort = {
  evaluate: async () => ({ status: 'deny' as const, message: 'contract test deny' }),
};

/** 预设返回 suspend，交由审批服务在测试中自动选择 call */
const suspendPolicy: ToolPolicyPort = {
  evaluate: async () => ({
    status: 'suspend' as const,
    message: 'contract test approval required',
    operation: {
      resources: [],
      riskReason: 'contract test approval',
      operationCategory: 'external-tool' as const,
      summary: 'contract test approval required',
    },
  }),
};

/** 构造装配完整的编排器 */
function createOrchestrator(policyPort: ToolPolicyPort, tracer?: AgentTracer): {
  orchestrator: ToolCallOrchestrator;
  session: SessionContext;
} {
  const registry = new ToolRegistry();
  const pluginRegistry = new PluginRegistry();
  if (tracer) {
    pluginRegistry.register(new TracerLogPlugin(() => tracer));
  }
  pluginRegistry.register(new HumanApprovalPlugin(policyPort, new ApprovalPolicy()));

  const session = new SessionContext('contract-orchestrator');
  session.setWorkMode('Safe');

  const toolDispatcher = new ToolDispatcher(session, registry);
  const effectApplier = new ApprovalEffectApplier();

  const orchestrator = new ToolCallOrchestrator(
    registry,
    toolDispatcher,
    pluginRegistry,
    session,
    effectApplier,
  );

  return { orchestrator, session };
}

describe('工具编排合约测试 — 真实装配', () => {
  it('deny 路径：ToolPolicyPort 返回 deny → BeforeTool 管线阻断并在 finalCallUpdate.error 体现', async () => {
    const { orchestrator } = createOrchestrator(denyPolicy);
    const abortController = new AbortController();

    const result = await orchestrator.execute(
      0,
      { id: 'deny-001', function: { name: 'readFile', arguments: '{}' } },
      abortController.signal,
      () => {},
    );

    // ToolCallOrchestrator 在 BeforeTool abort 时设 aborted=false，通过 error 传递阻断原因
    expect(result.finalCallUpdate.error).toBeDefined();
    expect(result.finalCallUpdate.error).toContain('contract test deny');
  });

  it('deny 路径应写入摘要化 BeforeTool audit 记录', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tool-denial-audit-contract-'));
    try {
      const tracer = new AgentTracer(tempDir, 'contract-orchestrator-audit', {
        operationalEnabled: true,
        auditEnabled: true,
        replayEnabled: false,
        customPatterns: [],
        traceRetentionDays: 7,
        traceRetentionSessions: 20,
        auditRetentionDays: 7,
        auditRetentionSessions: 20
      });
      const { orchestrator } = createOrchestrator(denyPolicy, tracer);

      await orchestrator.execute(
        0,
        {
          id: 'deny-audit-001',
          function: {
            name: 'readFile',
            arguments: JSON.stringify({ path: 'secret.txt', password: 'raw-deny-secret' })
          }
        },
        new AbortController().signal,
        () => {},
      );

      const auditFile = join(tempDir, '.myagent', 'traces', 'audit_contract-orchestrator-audit.jsonl');
      expect(existsSync(auditFile)).toBe(true);
      const auditContent = readFileSync(auditFile, 'utf-8');
      const records = auditContent.trim().split(/\r?\n/).map(line => JSON.parse(line));
      const beforeToolRecord = records.find(record =>
        record.type === 'lifecycle' &&
        record.eventName === 'BeforeTool' &&
        record.correlationId === 'deny-audit-001'
      );

      expect(beforeToolRecord).toBeDefined();
      expect(beforeToolRecord.policyResult).toBe('abort');
      expect(JSON.stringify(beforeToolRecord)).not.toContain('raw-deny-secret');
      expect(JSON.stringify(beforeToolRecord)).not.toContain('secret.txt');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('pass 路径：ToolPolicyPort 返回 pass → 工具正常执行', async () => {
    const { orchestrator } = createOrchestrator(passPolicy);
    const abortController = new AbortController();

    // 选取一个不依赖工作区初始化的实际内建工具，保持合约测试确定性。
    const result = await orchestrator.execute(
      0,
      { id: 'pass-001', function: { name: 'get_current_time', arguments: '{}' } },
      abortController.signal,
      () => {},
    );

    // 非阻断路径下 result 正常返回
    expect(result.finalCallUpdate.error).toBeUndefined();
    // Result 应包含执行结果。
    expect(result.finalCallUpdate.result).toBeDefined();
  });

  it('suspend/allow 路径：审批服务自动选择 call 后工具正常执行', async () => {
    const { orchestrator, session } = createOrchestrator(suspendPolicy);
    session.approvalService.setBypassMode(true);

    const result = await orchestrator.execute(
      0,
      { id: 'suspend-allow-001', function: { name: 'get_current_time', arguments: '{}' } },
      new AbortController().signal,
      () => {},
    );

    expect(result.finalCallUpdate.error).toBeUndefined();
    expect(result.finalCallUpdate.result).toBeDefined();
  });
});
