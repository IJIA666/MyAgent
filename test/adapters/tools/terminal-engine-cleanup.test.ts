/**
 * @fileoverview terminal-engine 会话级中止的真实进程链路集成测试：
 * 使用真实 ShellExecutionPlan（平台 killCommand 生效）、父子进程树驻留任务，
 * 中止子会话后验证父子进程均退出、父会话任务存活、挂起 Promise 收敛（不悬挂）。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  abortSessionTasks,
  activeTasks,
  runCommandEngine,
} from '../../../src/adapters/tools/impl/system/terminal-engine.js';
import { createShellExecutionPlan } from '../../../src/adapters/tools/impl/system/terminal-plan.js';

/**
 * 常驻父进程命令：spawn 一个子常驻进程并把子 PID 写入相对路径 child.pid（cwd 为执行目录），
 * 父自身也常驻。脚本只使用单引号字面量，经 pwsh 双引号字符串 + node -e 双层解析无引号冲突。
 */
function residentTreeCommand(): string {
  const script = [
    "const fs=require('fs');",
    "const cp=require('child_process');",
    "const c=cp.spawn(process.execPath,['-e','setInterval(() => {}, 1000)'],{stdio:'ignore'});",
    "fs.writeFileSync('child.pid',String(c.pid));",
    'setInterval(()=>{},1000);',
  ].join('');
  return `node -e "${script}"`;
}

describe('terminal-engine 会话级中止', () => {
  afterEach(async () => {
    // 兜底清理本测试启动的全部驻留进程，防止泄漏。
    await abortSessionTasks('cleanup-parent-session');
    await abortSessionTasks('cleanup-child-session');
    await abortSessionTasks('cleanup-other-session');
  });

  // 真实进程树 spawn 与回收需要超过 vitest 默认 5s 超时。
  it('中止子会话：父子进程树均退出、父会话任务存活、挂起 Promise 收敛', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'terminal-engine-cleanup-'));
    const childPidFile = join(cwd, 'child.pid');
    try {
      // 父会话后台驻留任务（不应被中止）。
      void runCommandEngine(
        RESIDENT_COMMAND,
        cwd,
        true,
        undefined,
        'cleanup-parent-session',
        createShellExecutionPlan(RESIDENT_COMMAND),
      );
      // 子会话后台驻留任务（将被中止）：真实 Plan 使平台 killCommand 生效。
      const childCommand = residentTreeCommand();
      const childPromise = runCommandEngine(
        childCommand,
        cwd,
        true,
        undefined,
        'cleanup-child-session',
        createShellExecutionPlan(childCommand),
      );
      // 另一子会话任务（不应被中止，验证按会话精确隔离）。
      void runCommandEngine(
        RESIDENT_COMMAND,
        cwd,
        true,
        undefined,
        'cleanup-other-session',
        createShellExecutionPlan(RESIDENT_COMMAND),
      );

      // 后台任务经 200ms 启动观察期后进入 RUNNING 且登记 sessionId；子 PID 文件就绪。
      await waitUntil(() =>
        [...activeTasks.values()].filter(task =>
          task.sessionId === 'cleanup-child-session' && task.status === 'RUNNING'
        ).length === 1
        && [...activeTasks.values()].filter(task =>
          task.sessionId === 'cleanup-parent-session' && task.status === 'RUNNING'
        ).length === 1
        && [...activeTasks.values()].filter(task =>
          task.sessionId === 'cleanup-other-session' && task.status === 'RUNNING'
        ).length === 1
        && existsSync(childPidFile)
      );
      const grandchildPid = Number.parseInt(readFileSync(childPidFile, 'utf8').trim(), 10);
      expect(Number.isInteger(grandchildPid) && grandchildPid > 0).toBe(true);

      // 中止子会话：只应命中 cleanup-child-session 的任务。
      await abortSessionTasks('cleanup-child-session');

      // 子任务挂起 Promise 收敛（不悬挂），状态不再 RUNNING。
      const childResult = await Promise.race([
        childPromise,
        new Promise<string>(resolve => setTimeout(() => resolve('__TIMEOUT__'), 8000)),
      ]);
      expect(childResult).not.toBe('__TIMEOUT__');
      await waitUntil(() =>
        [...activeTasks.values()].every(task =>
          task.sessionId !== 'cleanup-child-session' || task.status !== 'RUNNING'
        )
      );

      // 完整进程树回收：根进程（子任务自身）与孙进程（子任务 spawn 的 node）均退出。
      const rootPid = [...activeTasks.values()].find(task =>
        task.sessionId === 'cleanup-child-session'
      )?.child?.pid;
      expect(rootPid).toBeTypeOf('number');
      await waitUntil(() => !isProcessAlive(rootPid!) && !isProcessAlive(grandchildPid));

      // 父会话与另一子会话任务保持存活（RUNNING）。
      expect([...activeTasks.values()].some(task =>
        task.sessionId === 'cleanup-parent-session' && task.status === 'RUNNING'
      )).toBe(true);
      expect([...activeTasks.values()].some(task =>
        task.sessionId === 'cleanup-other-session' && task.status === 'RUNNING'
      )).toBe(true);
    } finally {
      // 先中止全部驻留进程释放目录占用，再清理临时目录。
      await abortSessionTasks('cleanup-parent-session');
      await abortSessionTasks('cleanup-child-session');
      await abortSessionTasks('cleanup-other-session');
      await new Promise(resolve => setTimeout(resolve, 100));
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30000);
});

/** 常驻 Node 进程命令：不退出，等待被杀。 */
const RESIDENT_COMMAND = 'node -e "setInterval(() => {}, 1000)"';

/** 以 0 信号探测进程存活（ESRCH 表示进程不存在）。 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH') {
      return false;
    }
    // EPERM 表示进程存在但无权探测；视为存活。
    return true;
  }
}

/** 在有限时间内等待谓词成立；超时输出任务状态快照供诊断。 */
async function waitUntil(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 8000) {
      const snapshot = [...activeTasks.values()].map(task =>
        `${task.sessionId ?? '?'}:${task.status}:${task.command.slice(0, 60)}`);
      throw new Error(`等待 terminal-engine 任务状态超时\n${snapshot.join('\n')}`);
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
