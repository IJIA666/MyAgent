/**
 * @file 跨进程文件锁的单元测试。
 * 覆盖互斥等待、超时、token 所有权和崩溃遗留锁恢复。
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CrossProcessLock,
  CrossProcessLockManager,
} from '../../src/utils/cross-process-lock.js';

describe('CrossProcessLockManager', () => {
  let tempDir: string;
  let lockPath: string;

  beforeEach(() => {
    tempDir = resolve(
      tmpdir(),
      `cross-process-lock-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });
    lockPath = resolve(tempDir, 'usage.lock');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('同一路径串行获取，前一个释放后后一个才能成功', async () => {
    const manager = new CrossProcessLockManager({
      pollIntervalMs: 5,
      timeoutMs: 500,
    });
    const first = await manager.acquire(lockPath);
    const secondPromise = manager.acquire(lockPath);

    await new Promise(resolveWait => setTimeout(resolveWait, 20));
    expect(existsSync(lockPath)).toBe(true);
    expect(first.release()).toBe(true);

    const second = await secondPromise;
    expect(second.token).not.toBe(first.token);
    expect(second.release()).toBe(true);
  });

  it('锁在期限内未释放时返回明确超时', async () => {
    const owner = await new CrossProcessLockManager().acquire(lockPath);
    const waiter = new CrossProcessLockManager({
      pollIntervalMs: 5,
      timeoutMs: 25,
    });

    await expect(waiter.acquire(lockPath)).rejects.toThrow('获取锁超时');
    owner.release();
  });

  it('跨进程锁轮询可由上游信号立即取消', async () => {
    const owner = await new CrossProcessLockManager().acquire(lockPath);
    const waiter = new CrossProcessLockManager({
      pollIntervalMs: 1_000,
      timeoutMs: 10_000,
    });
    const controller = new AbortController();
    const waiting = waiter.acquire(lockPath, controller.signal);

    controller.abort('service closed');
    try {
      await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      owner.release();
    }
  });

  it('非所有者 token 不能释放锁', async () => {
    const owner = await new CrossProcessLockManager().acquire(lockPath);
    const impostor = new CrossProcessLock(lockPath, 'not-the-owner');

    expect(impostor.release()).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
    expect(owner.release()).toBe(true);
  });

  it('超过 stale 窗口且 PID 不存活时可恢复遗留锁', async () => {
    writeFileSync(lockPath, JSON.stringify({
      token: 'stale-token',
      pid: 2_147_483_647,
      acquiredAt: Date.now() - 60_000,
    }), 'utf8');
    const manager = new CrossProcessLockManager({
      pollIntervalMs: 5,
      timeoutMs: 100,
      staleWindowMs: 10,
    });

    const recovered = await manager.acquire(lockPath);
    expect(recovered.token).not.toBe('stale-token');
    expect(recovered.release()).toBe(true);
  });
});
