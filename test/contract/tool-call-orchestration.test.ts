/**
 * @file 工具调用编排合约测试。
 * 使用真实 ToolRegistry、PluginRegistry、ToolDispatcher 和 ToolCallOrchestrator
 * 装配完整工具编排管线，验证统一权限网关的 allow 与 deny 路径。
 */

import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ToolRegistry } from '../../src/adapters/tools/toolRegistry.js';
import { PluginRegistry } from '../../src/core/usecases/plugins/plugin-registry.js';
import { TracerLogPlugin } from '../../src/core/usecases/plugins/TracerLogPlugin.js';

import { ToolCallOrchestrator } from '../../src/core/usecases/engine/tool-call-orchestrator.js';
import { ToolDispatcher } from '../../src/core/usecases/engine/ToolDispatcher.js';
import { SessionContext } from '../../src/core/domain/context.js';
import { AgentTracer } from '../../src/core/domain/tracer.js';
/** 构造装配完整的编排器 */
function createOrchestrator(tracer?: AgentTracer): {
  orchestrator: ToolCallOrchestrator;
  session: SessionContext;
  registry: ToolRegistry;
} {
  const registry = new ToolRegistry();
  const pluginRegistry = new PluginRegistry();
  if (tracer) {
    pluginRegistry.register(new TracerLogPlugin(() => tracer));
  }
  const session = new SessionContext('contract-orchestrator');

  const toolDispatcher = new ToolDispatcher(
    session,
    registry,
    join(tmpdir(), 'myagent-contract-tool-outputs'),
  );

  const orchestrator = new ToolCallOrchestrator(
    registry,
    toolDispatcher,
    pluginRegistry,
    session,
  );

  return { orchestrator, session, registry };
}

describe('工具编排合约测试 — 真实装配', () => {
  it('deny 路径：规则拒绝时工具注册表不得执行工具', async () => {
    const { registry, session } = createOrchestrator();
    session.getPermissionSessionState().getRuleStore().addRule('session', {
      source: 'session',
      ruleBehavior: 'deny',
      ruleValue: { toolName: 'get_current_time' },
    });
    await expect(registry.callTool('get_current_time', {}, session)).rejects.toThrow('被拒绝');
  });

  it('deny 路径应写入摘要化 BeforeTool audit 记录', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tool-denial-audit-contract-'));
    const tracesDir = join(tempDir, 'traces');
    const auditsDir = join(tempDir, 'audits');
    try {
      const tracer = new AgentTracer(tracesDir, auditsDir, 'contract-orchestrator-audit', {
        operationalEnabled: true,
        auditEnabled: true,
        replayEnabled: false,
        customPatterns: [],
        traceRetentionDays: 7,
        traceRetentionSessions: 20,
        auditRetentionDays: 7,
        auditRetentionSessions: 20
      });
      const { orchestrator, session } = createOrchestrator(tracer);
      session.getPermissionSessionState().getRuleStore().addRule('session', {
        source: 'session',
        ruleBehavior: 'deny',
        ruleValue: { toolName: 'get_current_time' },
      });

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

      const auditFile = join(auditsDir, 'audit_contract-orchestrator-audit.jsonl');
      expect(existsSync(auditFile)).toBe(true);
      const auditContent = readFileSync(auditFile, 'utf-8');
      const records = auditContent.trim().split(/\r?\n/).map(line => JSON.parse(line));
      const beforeToolRecord = records.find(record =>
        record.type === 'lifecycle' &&
        record.eventName === 'BeforeTool' &&
        record.correlationId === 'deny-audit-001'
      );

      expect(beforeToolRecord).toBeDefined();
      expect(beforeToolRecord.policyResult).toBeDefined();
      expect(JSON.stringify(beforeToolRecord)).not.toContain('raw-deny-secret');
      expect(JSON.stringify(beforeToolRecord)).not.toContain('secret.txt');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('allow 路径：统一权限网关允许后工具正常执行', async () => {
    const { orchestrator, session } = createOrchestrator();
    session.setPermissionMode('bypassPermissions');
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

  it('默认模式下只读工具应直接执行', async () => {
    const { orchestrator, session } = createOrchestrator();
    session.setPermissionMode('default');

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
