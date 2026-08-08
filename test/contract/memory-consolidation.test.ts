/**
 * @file 后台记忆巩固契约（对齐 Claude Code Auto Dream）。
 * 双门控调度、互斥锁与时间状态闭环、受限工具视图（执行限制 + 控制文件保护）、
 * fork 执行快照来源、手动入口与单飞合并。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelRequestSnapshot } from '../../src/ports/driven/llm/LlmPort.js';
import type { ToolRegistryPort } from '../../src/ports/driven/tools/ToolRegistryPort.js';
import type { PermissionSessionState } from '../../src/core/domain/permissions/permission-session-state.js';
import type { TrustedCallContext } from '../../src/core/domain/permissions/trusted-call-context.js';
import {
  MemoryConsolidationService,
} from '../../src/core/usecases/brain/memory-consolidation.js';
import {
  MemoryConsolidationToolView,
} from '../../src/core/usecases/brain/memory-consolidation-tool-view.js';
import {
  readLastConsolidatedAt,
  writeLastConsolidatedAt,
} from '../../src/core/usecases/brain/memory-consolidation-state.js';
import type { SubagentRuntime } from '../../src/core/usecases/subagent/SubagentRuntime.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

/** 构造完整权限快照。 */
function makePermissionSnapshot() {
  return {
    mode: 'default',
    prePlanMode: null,
    rules: [],
    additionalDirectories: [],
    agentMemoryRoots: [],
    stateVersion: 0,
    modeTransitions: [],
  };
}

/** 构造测试请求快照。 */
function makeRequestSnapshot(tools: unknown[] = []): ModelRequestSnapshot {
  return { tools, messages: [] } as unknown as ModelRequestSnapshot;
}

/** 构造服务（含 mock runtime）。 */
function createService(
  tempDir: string,
  overrides: Partial<Parameters<typeof buildService>[1]> = {},
): ReturnType<typeof buildService> {
  return buildService(tempDir, overrides);
}

/** 装配服务测试替身。 */
function buildService(
  tempDir: string,
  overrides: {
    runTaskMock?: ReturnType<typeof vi.fn>;
    config?: { enabled: boolean; minHours: number; minSessions: number };
    currentSessionId?: string;
    autoMemoryEnabled?: boolean;
  } = {},
) {
  const memoryDir = join(tempDir, 'memory');
  const sessionsDir = join(tempDir, 'sessions');
  mkdirSync(memoryDir, { recursive: true });
  const runTaskMock = overrides.runTaskMock ?? vi.fn();
  const parentPermissionState = {
    snapshot: () => makePermissionSnapshot(),
  } as unknown as PermissionSessionState;
  const parentCaller = { caller: { callerId: 'contract-parent' } } as unknown as TrustedCallContext;
  const options = {
    toolRegistry: {
      getTools: async () => [],
      getTool: () => undefined,
      callTool: async () => ({
        value: null,
        effect: { kind: 'none' as const, executionStarted: false, completed: false, resources: [], reason: 'no_execution' as const },
      }),
      close: async () => undefined,
    } as unknown as ToolRegistryPort,
    parentPermissionStateProvider: () => parentPermissionState,
    parentCallerProvider: () => parentCaller,
    subagentRuntime: { runTask: runTaskMock } as unknown as SubagentRuntime,
    memoryDir,
    sessionsDir,
    currentSessionIdProvider: () => overrides.currentSessionId ?? 'current-session',
    autoMemoryEnabledProvider: () => overrides.autoMemoryEnabled ?? true,
    requestSnapshotProvider: () => makeRequestSnapshot(),
    lastAssistantMessageProvider: () => undefined,
    configProvider: () => overrides.config ?? { enabled: true, minHours: 24, minSessions: 5 },
    notify: vi.fn(),
  };
  const service = new MemoryConsolidationService(options);
  return { service, options, runTaskMock, memoryDir, sessionsDir };
}

/** 写入会话快照（指定 mtime）。 */
function writeSession(sessionsDir: string, id: string, mtimeMs: number): void {
  mkdirSync(sessionsDir, { recursive: true });
  const file = join(sessionsDir, `session_${id}.json`);
  writeFileSync(file, '{}', 'utf-8');
  utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
}

describe('后台记忆巩固契约', () => {
  it('时间门未过时不启动', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'contract-memory-consolidation-'));
    tempRoots.push(tempDir);
    const { service, options, runTaskMock } = createService(tempDir);

    // 时间门未过：1 小时前刚巩固 → 不执行（即使会话数满足）。
    writeLastConsolidatedAt(options.memoryDir, new Date(Date.now() - 3_600_000).toISOString());
    writeSession(options.sessionsDir, 'a', Date.now());
    service.checkAndRun();
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(runTaskMock).not.toHaveBeenCalled();
  });

  it('时间与会话门齐过才执行且成功推进时间', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'contract-memory-consolidation-'));
    tempRoots.push(tempDir);
    const { service, options, runTaskMock } = createService(tempDir);

    // 时间门过（24h 前）+ 会话门过（5 个非当前会话）→ 执行。
    writeLastConsolidatedAt(options.memoryDir, new Date(Date.now() - 24 * 3_600_000).toISOString());
    for (let i = 0; i < 5; i++) {
      writeSession(options.sessionsDir, `s${i}`, Date.now());
    }
    runTaskMock.mockResolvedValue({
      status: 'completed',
      agentId: 'agent-1',
      eventCount: 2,
    });
    service.checkAndRun();
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(runTaskMock).toHaveBeenCalled();
    // 成功 → 时间状态推进。
    expect(readLastConsolidatedAt(options.memoryDir)).toBeGreaterThan(0);
  });

  it('门控冻结的会话列表传入任务（启动后不按新时间重新扫描）', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'contract-memory-consolidation-'));
    tempRoots.push(tempDir);
    const { service, options, runTaskMock } = createService(tempDir);

    // 时间门过 + 5 个会话（其中当前会话被排除，实际 4 个非当前）。
    writeLastConsolidatedAt(options.memoryDir, new Date(Date.now() - 24 * 3_600_000).toISOString());
    for (let i = 0; i < 5; i++) {
      writeSession(options.sessionsDir, `s${i}`, Date.now());
    }
    runTaskMock.mockResolvedValue({ status: 'completed', agentId: 'a', eventCount: 1 });
    service.checkAndRun();
    await new Promise(resolve => setTimeout(resolve, 80));
    // 任务必须收到冻结的会话 ID 列表：prompt 应包含这些 ID（含 5 个会话的计数）。
    const taskArg = runTaskMock.mock.calls[0][0] as { prompt: string };
    expect(taskArg.prompt).toContain('5');
    expect(taskArg.prompt).toContain('s0');
    expect(taskArg.prompt).toContain('s4');
  });

  it('当前会话不计入会话门', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'contract-memory-consolidation-'));
    tempRoots.push(tempDir);
    const { service, options, runTaskMock } = createService(tempDir, {
      currentSessionId: 'current',
    });
    writeLastConsolidatedAt(options.memoryDir, new Date(Date.now() - 24 * 3_600_000).toISOString());
    // 只有当前会话被触碰（不计入）→ 不足 5，不执行。
    writeSession(options.sessionsDir, 'current', Date.now());
    service.checkAndRun();
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(runTaskMock).not.toHaveBeenCalled();
  });

  it('Auto Memory 关闭时不调度', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'contract-memory-consolidation-'));
    tempRoots.push(tempDir);
    const { service, options, runTaskMock } = createService(tempDir, {
      autoMemoryEnabled: false,
      currentSessionId: 'current',
    });
    writeLastConsolidatedAt(options.memoryDir, new Date(Date.now() - 24 * 3_600_000).toISOString());
    for (let i = 0; i < 5; i++) {
      writeSession(options.sessionsDir, `s${i}`, Date.now());
    }
    service.checkAndRun();
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(runTaskMock).not.toHaveBeenCalled();
  });

  it('失败恢复旧时间状态并释放锁，成功保留新时间', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'contract-memory-consolidation-'));
    tempRoots.push(tempDir);
    const { service, options, runTaskMock } = createService(tempDir);
    const oldIso = '2026-07-01T12:00:00.000Z';
    writeLastConsolidatedAt(options.memoryDir, oldIso);

    // 失败 → 恢复旧时间。
    runTaskMock.mockRejectedValue(new Error('模型失败'));
    await expect(service.runManual()).rejects.toThrow('模型失败');
    expect(readLastConsolidatedAt(options.memoryDir)).toBe(Date.parse(oldIso));

    // 成功 → 保留新时间。
    runTaskMock.mockResolvedValue({ status: 'completed', agentId: 'a', eventCount: 1 });
    const result = await service.runManual();
    expect(result.ok).toBe(true);
    expect(readLastConsolidatedAt(options.memoryDir)).toBeGreaterThan(Date.parse(oldIso));
  });

  it('手动入口以极短超时获取锁：被持有时报告占用而非真实错误', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'contract-memory-consolidation-'));
    tempRoots.push(tempDir);
    const { service, options } = createService(tempDir);
    // 模拟他进程持有 fresh 锁（PID 存活且 token 不同）。
    const lockFile = join(options.memoryDir, '.consolidate-lock');
    writeFileSync(lockFile, JSON.stringify({
      token: 'other-token',
      pid: process.pid,
      acquiredAt: Date.now(),
    }), 'utf-8');
    const result = await service.runManual();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('已有巩固进行中');
    }
  });

  it('受限工具视图：非允许工具调用拒绝、控制文件 Edit/Write 拒绝', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'contract-memory-consolidation-'));
    tempRoots.push(tempDir);
    const memoryDir = join(tempDir, 'memory');
    mkdirSync(memoryDir, { recursive: true });
    const callTool = vi.fn();
    const view = new MemoryConsolidationToolView({
      getTools: async () => [],
      getTool: () => undefined,
      callTool,
      close: async () => undefined,
    } as unknown as ToolRegistryPort, {
      memoryDir,
      parentPermissionState: {
        snapshot: () => makePermissionSnapshot(),
      } as unknown as PermissionSessionState,
      parentCaller: { caller: { callerId: 'view-parent' } } as unknown as TrustedCallContext,
    });

    // 非允许工具（如 applyPatch）→ 调用拒绝。
    await expect(view.callTool('applyPatch', {})).rejects.toThrow('工具拒绝');
    expect(callTool).not.toHaveBeenCalled();

    // 控制文件 Edit → 拒绝（即使物理路径在记忆根内）。
    await expect(view.callTool('writeFile', {
      targetPath: join(memoryDir, '.consolidate-lock'),
    })).rejects.toThrow('调度控制文件');
    expect(callTool).not.toHaveBeenCalled();

    // 允许工具（readFile）→ 通过策略委托父注册表。
    await view.callTool('readFile', { path: join(memoryDir, 'a.md') });
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('受限工具视图：child caller 派生且 filesTouched 在视图内收集', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'contract-memory-consolidation-'));
    tempRoots.push(tempDir);
    const memoryDir = join(tempDir, 'memory');
    mkdirSync(memoryDir, { recursive: true });
    const callTool = vi.fn().mockResolvedValue({
      value: { ok: true },
      effect: {
        kind: 'write',
        executionStarted: true,
        completed: true,
        resources: [join(memoryDir, 'topic.md'), join(memoryDir, 'topic.md')],
        reason: 'declared_write_tool',
      },
    });
    const view = new MemoryConsolidationToolView({
      getTools: async () => [],
      getTool: () => undefined,
      callTool,
      close: async () => undefined,
    } as unknown as ToolRegistryPort, {
      memoryDir,
      parentPermissionState: {
        snapshot: () => makePermissionSnapshot(),
      } as unknown as PermissionSessionState,
      parentCaller: { caller: { callerId: 'view-parent' } } as unknown as TrustedCallContext,
    });

    await view.callTool('writeFile', { targetPath: join(memoryDir, 'topic.md') });
    // caller 是派生 child caller（不是父 caller 原文）。
    const hooks = callTool.mock.calls[0][7] as { securityContext?: { caller?: { caller?: { callerId?: string } } } };
    expect(hooks?.securityContext?.caller?.caller?.callerId).toBeDefined();
    // filesTouched 去重收集（同一文件两次写入只计一次）。
    expect(view.getFilesTouched()).toEqual([join(memoryDir, 'topic.md')]);
  });

  it('单飞：连续模型回合只触发一次执行', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'contract-memory-consolidation-'));
    tempRoots.push(tempDir);
    const { service, options, runTaskMock } = createService(tempDir);
    writeLastConsolidatedAt(options.memoryDir, new Date(Date.now() - 24 * 3_600_000).toISOString());
    for (let i = 0; i < 5; i++) {
      writeSession(options.sessionsDir, `s${i}`, Date.now());
    }
    runTaskMock.mockResolvedValue({ status: 'completed', agentId: 'a', eventCount: 1 });
    // 同一回合连续触发多次 → 单飞合并为一次。
    service.checkAndRun();
    service.checkAndRun();
    service.checkAndRun();
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(runTaskMock).toHaveBeenCalledTimes(1);
  });
});
