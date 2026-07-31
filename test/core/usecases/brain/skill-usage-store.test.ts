/**
 * @file Skill usage sidecar 仓储测试。
 * 覆盖所有权、遥测持久化、跨进程并发和损坏降级语义。
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillUsageStore } from '../../../../src/core/usecases/brain/skill-usage-store.js';

describe('SkillUsageStore', () => {
  let tempDir: string;
  let usagePath: string;

  beforeEach(() => {
    tempDir = resolve(
      tmpdir(),
      `skill-usage-store-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });
    usagePath = resolve(tempDir, '.usage.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('缺失文件是健康的空遥测', () => {
    const store = new SkillUsageStore(usagePath);

    expect(store.readAll()).toEqual({});
    expect(store.health()).toEqual({
      healthy: true,
      degradedReason: undefined,
      skillCount: 0,
      agentSkillCount: 0,
    });
  });

  it('已有记录的 view/use/patch/pin/state 更新必须真实落盘', async () => {
    const store = new SkillUsageStore(usagePath);
    await store.markAgentCreated('posting-playbook');
    await store.recordView('posting-playbook');
    await store.recordUse('posting-playbook');
    await store.recordPatch('posting-playbook');
    await store.pin('posting-playbook');
    await store.setState('posting-playbook', 'stale');

    const reloaded = new SkillUsageStore(usagePath).read('posting-playbook');
    expect(reloaded).toMatchObject({
      createdBy: 'agent',
      viewCount: 1,
      useCount: 1,
      patchCount: 1,
      pinned: true,
      state: 'stale',
    });
    expect(reloaded?.lastViewedAt).not.toBeNull();
    expect(reloaded?.lastUsedAt).not.toBeNull();
    expect(reloaded?.lastPatchedAt).not.toBeNull();
  });

  it('前台 unmanaged 记录可被 adopt，adopt 后成为后台可管理策略所有权', async () => {
    const store = new SkillUsageStore(usagePath);
    await store.markUnmanaged('manual-skill');
    expect(store.read('manual-skill')?.createdBy).toBeNull();

    await expect(store.adopt('manual-skill')).resolves.toBe(true);
    expect(store.read('manual-skill')?.createdBy).toBe('agent');
    await expect(store.adopt('manual-skill')).resolves.toBe(false);
  });

  it('两个子进程并发更新同一记录不丢计数', async () => {
    const store = new SkillUsageStore(usagePath);
    await store.markAgentCreated('shared-skill');
    const childPath = fileURLToPath(
      new URL('../../../fixtures/skill-usage-child.ts', import.meta.url),
    );

    await Promise.all([
      runChild(childPath, usagePath, 'shared-skill', 8),
      runChild(childPath, usagePath, 'shared-skill', 8),
    ]);

    expect(store.read('shared-skill')?.viewCount).toBe(16);
  });

  it('损坏 sidecar 退化为空、同一指纹只通知一次且写操作失败关闭', async () => {
    const notify = vi.fn();
    const malformed = '{"skill": ';
    writeFileSync(usagePath, malformed, 'utf8');
    const store = new SkillUsageStore(usagePath, { notify });

    expect(store.health().healthy).toBe(false);
    expect(store.readAll()).toEqual({});
    expect(store.health().healthy).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
    await expect(store.markAgentCreated('new-skill')).rejects.toThrow('拒绝覆盖');
    expect(readFileSync(usagePath, 'utf8')).toBe(malformed);
  });

  it('结构非法同样进入 degraded，不能猜测 createdBy', () => {
    writeFileSync(usagePath, JSON.stringify({
      bad: {
        createdBy: 'unknown',
        useCount: 0,
      },
    }), 'utf8');
    const store = new SkillUsageStore(usagePath);

    expect(store.readAll()).toEqual({});
    expect(store.health()).toMatchObject({
      healthy: false,
      skillCount: 0,
      agentSkillCount: 0,
    });
  });
});

/** 启动一个真实 Node 子进程执行 usage 更新。 */
function runChild(
  childPath: string,
  usagePath: string,
  skillName: string,
  iterations: number,
): Promise<void> {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', childPath, usagePath, skillName, String(iterations)],
      {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
    });
    child.once('error', rejectChild);
    child.once('exit', code => {
      if (code === 0) {
        resolveChild();
      } else {
        rejectChild(new Error(`usage child 退出码 ${code}: ${stderr}`));
      }
    });
  });
}
