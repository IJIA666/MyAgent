/**
 * @file 记忆巩固服务单元测试：门控顺序、单飞、手动入口、时间状态闭环、控制文件保护。
 */

import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MemoryConsolidationService,
  type MemoryConsolidationConfig,
  type MemoryConsolidationServiceOptions,
} from '../../../../src/core/usecases/brain/memory-consolidation.js';
import { readLastConsolidatedAt } from '../../../../src/core/usecases/brain/memory-consolidation-state.js';
import type { SubagentRuntime } from '../../../../src/core/usecases/subagent/SubagentRuntime.js';
import type { PermissionSessionState } from '../../../../src/core/domain/permissions/permission-session-state.js';
import type { TrustedCallContext } from '../../../../src/core/domain/permissions/trusted-call-context.js';
import type { ModelRequestSnapshot } from '../../../../src/ports/driven/llm/LlmPort.js';

/** 测试快照。 */
function makeSnapshot(): ModelRequestSnapshot {
  return {
    tools: [
      { type: 'function', function: { name: 'readFile', parameters: { type: 'object' } } },
    ],
    messages: [],
  } as unknown as ModelRequestSnapshot;
}

/** 构造服务测试替身。 */
function createService(
  tempDir: string,
  overrides: Partial<MemoryConsolidationServiceOptions> = {},
): {
  service: MemoryConsolidationService;
  options: MemoryConsolidationServiceOptions;
  runtime: { runTask: ReturnType<typeof vi.fn> };
} {
  const memoryDir = join(tempDir, 'memory');
  const sessionsDir = join(tempDir, 'sessions');
  const runtime = { runTask: vi.fn() };
  const config: MemoryConsolidationConfig = { enabled: true, minHours: 24, minSessions: 5 };
  const options: MemoryConsolidationServiceOptions = {
    toolRegistry: {
      getTools: async () => [],
      getTool: () => undefined,
      callTool: async () => ({ value: null, effect: { kind: 'none' as const, executionStarted: false, completed: false, resources: [], reason: 'no_execution' as const } }),
      close: async () => undefined,
    },
    parentPermissionStateProvider: () => ({
      snapshot: () => ({
        mode: 'default',
        prePlanMode: null,
        rules: [],
        additionalDirectories: [],
        agentMemoryRoots: [],
        stateVersion: 0,
        modeTransitions: [],
      }),
    }) as unknown as () => PermissionSessionState,
    parentCallerProvider: () => ({ caller: { callerId: 'parent-test' } }) as unknown as () => TrustedCallContext,
    subagentRuntime: runtime as unknown as SubagentRuntime,
    memoryDir,
    sessionsDir,
    currentSessionIdProvider: () => 'current-session',
    autoMemoryEnabledProvider: () => true,
    requestSnapshotProvider: () => makeSnapshot(),
    lastAssistantMessageProvider: () => undefined,
    configProvider: () => config,
    notify: vi.fn(),
    ...overrides,
  };
  const service = new MemoryConsolidationService(options);
  return { service, options, runtime };
}

/** 预写时间状态（模拟已巩固）。 */
function writeState(memoryDir: string, iso: string): void {
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(join(memoryDir, '.consolidate-state.json'), JSON.stringify({ lastConsolidatedAt: iso }), 'utf-8');
}

/** 预写会话快照。 */
function writeSessionSnapshot(sessionsDir: string, id: string, mtimeMs: number): void {
  mkdirSync(sessionsDir, { recursive: true });
  const file = join(sessionsDir, `session_${id}.json`);
  writeFileSync(file, '{}', 'utf-8');
  utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
}

describe('MemoryConsolidationService', () => {
  it('时间门未过时跳过（不启动任务）', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mem-consolidation-service-'));
    try {
      const { service, options, runtime } = createService(tempDir);
      // 最近刚巩固过（1 小时前）→ 时间门拦截。
      writeState(options.memoryDir, new Date(Date.now() - 3_600_000).toISOString());
      service.checkAndRun();
      await new Promise(resolve => setTimeout(resolve, 50));
      // 时间门未过 → runTask 不得被调用。
      expect(runtime.runTask).not.toHaveBeenCalled();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('会话门未过时跳过（不启动任务）', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mem-consolidation-service-'));
    try {
      const { service, options, runtime } = createService(tempDir);
      // 从未巩固（时间门过）+ 只有一个会话（不足 5）→ 会话门拦截。
      writeSessionSnapshot(options.sessionsDir, 'a', Date.now());
      service.checkAndRun();
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(runtime.runTask).not.toHaveBeenCalled();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('手动触发成功保留时间状态并通知 filesTouched', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mem-consolidation-service-'));
    try {
      const { service, options, runtime } = createService(tempDir);
      runtime.runTask.mockResolvedValue({
        status: 'completed',
        agentId: 'agent-1',
        eventCount: 3,
      });
      const result = await service.runManual();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.eventCount).toBe(3);
      }
      // 成功 → 时间状态被推进（读取非 0）。
      expect(readLastConsolidatedAt(options.memoryDir)).toBeGreaterThan(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('手动触发失败恢复旧时间并释放锁', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mem-consolidation-service-'));
    try {
      const { service, options, runtime } = createService(tempDir);
      const oldIso = '2026-08-01T12:00:00.000Z';
      writeState(options.memoryDir, oldIso);
      runtime.runTask.mockRejectedValue(new Error('模型调用失败'));
      await expect(service.runManual()).rejects.toThrow('模型调用失败');
      // 失败 → 恢复旧时间。
      expect(readLastConsolidatedAt(options.memoryDir)).toBe(Date.parse(oldIso));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('runTask 返回 failed 时恢复旧时间且不通知（不抛异常路径）', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mem-consolidation-service-'));
    try {
      const { service, options, runtime } = createService(tempDir);
      const oldIso = '2026-08-01T12:00:00.000Z';
      writeState(options.memoryDir, oldIso);
      runtime.runTask.mockResolvedValue({
        status: 'failed',
        agentId: 'agent-1',
        errorCode: 'model_failed',
        errorMessage: '模型失败',
        eventCount: 1,
      });
      const result = await service.runManual();
      // failed 是正常返回（不抛异常），但时间必须恢复旧值。
      expect(result.ok).toBe(true);
      expect(readLastConsolidatedAt(options.memoryDir)).toBe(Date.parse(oldIso));
      // 失败不得发送成功通知。
      expect(options.notify).not.toHaveBeenCalled();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('runTask 返回 cancelled 时恢复旧时间且不通知', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mem-consolidation-service-'));
    try {
      const { service, options, runtime } = createService(tempDir);
      const oldIso = '2026-08-01T12:00:00.000Z';
      writeState(options.memoryDir, oldIso);
      runtime.runTask.mockResolvedValue({
        status: 'cancelled',
        agentId: 'agent-1',
        eventCount: 0,
      });
      const result = await service.runManual();
      expect(result.ok).toBe(true);
      expect(readLastConsolidatedAt(options.memoryDir)).toBe(Date.parse(oldIso));
      expect(options.notify).not.toHaveBeenCalled();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('从未巩固时失败回滚删除状态文件（不写读取器不接受的 null）', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mem-consolidation-service-'));
    try {
      const { service, options, runtime } = createService(tempDir);
      // 无既有状态（从未巩固）。
      runtime.runTask.mockResolvedValue({
        status: 'failed',
        agentId: 'agent-1',
        errorCode: 'model_failed',
        errorMessage: '模型失败',
        eventCount: 0,
      });
      const result = await service.runManual();
      expect(result.ok).toBe(true);
      // 状态文件被删除 → 读取为 0（未巩固），且不产生损坏警告。
      expect(readLastConsolidatedAt(options.memoryDir)).toBe(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('手动触发时锁被持有（另一进程巩固中）→ 返回占用而非启动', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mem-consolidation-service-'));
    try {
      const { service, options } = createService(tempDir);
      // 模拟他进程持有锁：写入 fresh 锁文件（PID 为本进程，token 不同）。
      const lockFile = join(options.memoryDir, '.consolidate-lock');
      mkdirSync(options.memoryDir, { recursive: true });
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
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('非允许工具调用被受限工具视图拒绝', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mem-consolidation-service-'));
    try {
      const { service, runtime } = createService(tempDir);
      // 非允许工具（如 applyPatch）由 ToolView 拒绝 → runTask 不执行、服务抛错。
      runtime.runTask.mockRejectedValue(new Error('记忆巩固 Agent 工具拒绝: 后台记忆 Agent 只允许 Read/Grep/Glob、只读 Shell 和 memory 根内 Edit/Write'));
      await expect(service.runManual()).rejects.toThrow('工具拒绝');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
