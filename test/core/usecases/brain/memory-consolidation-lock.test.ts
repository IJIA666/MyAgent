/**
 * @file 记忆巩固互斥锁测试：复用 CrossProcessLockManager 的 wx 原子创建 + token 校验语义。
 * 覆盖：获取成功、被存活持有拒绝、超时且 PID 死亡才回收、超时但存活不回收、
 * release 只删自己 token、同进程并发竞争（多个 LockManager 实例争同一路径）。
 */

import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CrossProcessLockManager } from '../../../../src/utils/cross-process-lock.js';

/** 创建临时目录并返回锁文件路径。 */
function createLockPath(): { lockFile: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'mem-consolidation-lock-'));
  const lockFile = join(dir, '.consolidate-lock');
  return { lockFile, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('记忆巩固互斥锁', () => {
  it('无既有锁时获取成功且写入 token 元数据', async () => {
    const { lockFile, cleanup } = createLockPath();
    try {
      const manager = new CrossProcessLockManager({ pollIntervalMs: 5, timeoutMs: 200 });
      const lock = await manager.acquire(lockFile);
      expect(lock).toBeDefined();
      expect(existsSync(lockFile)).toBe(true);
      const content = JSON.parse(readFileSync(lockFile, 'utf-8')) as { token: string; pid: number };
      expect(content.token).toBe(lock.token);
      expect(content.pid).toBe(process.pid);
      lock.release();
      expect(existsSync(lockFile)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('锁被存活进程持有（token 相同进程）时获取失败', async () => {
    const { lockFile, cleanup } = createLockPath();
    try {
      // 同一进程内两个 manager 实例竞争同一路径：第一个持有，第二个必须失败。
      const manager = new CrossProcessLockManager({ pollIntervalMs: 5, timeoutMs: 100 });
      const lock = await manager.acquire(lockFile);
      // 同一进程内 PID 相同——token 是区分持有者的关键。
      writeFileSync(lockFile, JSON.stringify({
        token: 'other-process-token',
        pid: process.pid,
        acquiredAt: Date.now(),
      }), 'utf-8');
      // 手动构造的锁文件（模拟他进程持有，token 不匹配且 PID 存活）→ 不应被回收。
      const stale = new CrossProcessLockManager({ pollIntervalMs: 5, timeoutMs: 100, staleWindowMs: 60_000 });
      await expect(stale.acquire(lockFile)).rejects.toThrow('获取锁超时');
      lock.release();
    } finally {
      cleanup();
    }
  });

  it('release 只删除 token 匹配的锁文件', async () => {
    const { lockFile, cleanup } = createLockPath();
    try {
      const manager = new CrossProcessLockManager({ pollIntervalMs: 5, timeoutMs: 200 });
      const lock = await manager.acquire(lockFile);
      // 外部改写 token（模拟他进程接管后）→ release 不得删除。
      writeFileSync(lockFile, JSON.stringify({
        token: 'someone-else',
        pid: 99999,
        acquiredAt: Date.now(),
      }), 'utf-8');
      expect(lock.release()).toBe(false);
      expect(existsSync(lockFile)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('同进程并发竞争：多个 manager 实例争同一路径只有一个成功', async () => {
    const { lockFile, cleanup } = createLockPath();
    try {
      const managerA = new CrossProcessLockManager({ pollIntervalMs: 5, timeoutMs: 100 });
      const managerB = new CrossProcessLockManager({ pollIntervalMs: 5, timeoutMs: 100 });
      const [a, b] = await Promise.allSettled([
        managerA.acquire(lockFile),
        managerB.acquire(lockFile),
      ]);
      const succeeded = [a, b].filter(r => r.status === 'fulfilled').length;
      expect(succeeded).toBe(1);
      // 释放成功后第二个可以获取。
      if (a.status === 'fulfilled') {
        a.value.release();
      } else if (b.status === 'fulfilled') {
        b.value.release();
      }
      const after = await managerA.acquire(lockFile);
      after.release();
    } finally {
      cleanup();
    }
  });

  it('陈旧锁（超时且 PID 死亡）被回收', async () => {
    const { lockFile, cleanup } = createLockPath();
    try {
      // 写入一个 dead PID（通常不可达的 PID）且 acquiredAt 超 stale window。
      writeFileSync(lockFile, JSON.stringify({
        token: 'dead-process',
        pid: 2_147_483_647,
        acquiredAt: Date.now() - 2 * 3_600_000,
      }), 'utf-8');
      const manager = new CrossProcessLockManager({
        pollIntervalMs: 5,
        timeoutMs: 200,
        staleWindowMs: 60_000,
      });
      const lock = await manager.acquire(lockFile);
      expect(lock).toBeDefined();
      lock.release();
    } finally {
      cleanup();
    }
  });

  it('锁超过 stale window 但 PID 存活时不回收', async () => {
    const { lockFile, cleanup } = createLockPath();
    try {
      // 本进程 PID 存活，但 acquiredAt 超 stale window → 不得回收。
      writeFileSync(lockFile, JSON.stringify({
        token: 'live-process',
        pid: process.pid,
        acquiredAt: Date.now() - 2 * 3_600_000,
      }), 'utf-8');
      const manager = new CrossProcessLockManager({
        pollIntervalMs: 5,
        timeoutMs: 100,
        staleWindowMs: 60_000,
      });
      await expect(manager.acquire(lockFile)).rejects.toThrow('获取锁超时');
    } finally {
      cleanup();
    }
  });
});
