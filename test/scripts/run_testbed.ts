/* eslint-disable n/no-process-env */
/**
 * @file run_testbed.ts
 * @description 虚拟 Windows C 盘清理评测的一键主控运行脚本。
 * 负责自动初始化测试靶场，派生智能体子进程并在内存中动态重定向其工作区环境变量，
 * 建立终端交互的 stdin/stdout 双向透传，捕获退出事件并自动运行断言评分与环境销毁收尾。
 */

import { spawn, ChildProcess } from 'child_process';
import { setupTestbed } from './setup_testbed.js';
import { teardownTestbed } from './teardown_testbed.js';
import { verifyCleanup, printMarkdownReport } from './verify_cleanup.js';

/**
 * 启动一键闭环磁盘清理评测的主函数。
 */
export function runTestbed(): void {
  console.clear();
  console.log('====================================================');
  console.log('[主控] 启动虚拟 Windows 磁盘清理智能体评测床 (Runner)');
  console.log('====================================================\n');

  let driveLetter = '';
  let lockProcess: ChildProcess | null = null;

  // 在初始化部署前，执行前置幂等清场，防止前一次测试强退或失败导致残留状态影响本次运行
  try {
    teardownTestbed();
  } catch {
    /* 忽略前置幂等清理异常 */
  }

  try {
    // 1. 初始化部署测试床，获得虚拟挂载盘符和文件锁定子进程
    const setupResult = setupTestbed();
    driveLetter = setupResult.driveLetter;
    lockProcess = setupResult.lockProcess;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`\n[错误] 测试床搭建失败，无法继续评测：${errorMsg}`);
    teardownTestbed();
    process.exit(1);
  }

  console.log('\n[主控] 正在内存中动态注入工作区重定向，派生启动智能体主程序...');
  console.log('[提示] 您将直接在当前终端窗口中与智能体交互对话。');
  console.log('[提示] 请输入 "exit" 并回车以安全结束清理测试并生成评分报告。\n');

  // 2. 派生智能体运行子进程
  // 核心：动态注入 AUTHORIZED_WORKSPACE_DIR 环境变量重定向沙箱边界，并透传 stdio 实现完美对话交互
  const agentProcess = spawn('node', [
    '--disable-warning=DEP0040',
    '--enable-source-maps',
    '--import', 'tsx',
    'src/index.ts'
  ], {
    env: {
      ...process.env,
      AUTHORIZED_WORKSPACE_DIR: `${driveLetter}\\`
    },
    stdio: 'inherit' // 透传键盘输入与智能体打印输出，实现交互聊天
  });

  // 3. 监听智能体子进程退出事件
  agentProcess.on('close', (code) => {
    console.log('\n====================================================');
    console.log('[主控] 智能体主程序已退出。正在启动自动化断言与校验评估...');
    console.log('====================================================\n');

    // 杀死生命周期锁定的后台 Powershell 锁进程，保证可以成功校验与物理清理
    if (lockProcess) {
      console.log('[主控] 正在注销生命周期文件写锁句柄...');
      lockProcess.kill();
    }

    try {
      // 4. 执行自动断言打分与 Markdown 报告输出
      const evaluationResult = verifyCleanup(driveLetter);
      printMarkdownReport(evaluationResult, driveLetter);
    } catch (evalError) {
      const evalMsg = evalError instanceof Error ? evalError.message : String(evalError);
      console.error(`[主控] 自动化校验评估失败：${evalMsg}`);
    } finally {
      // 5. 强行执行环境销毁，解挂 subst 盘符并递归删除物理 mock 目录
      console.log('\n[主控] 正在执行环境销毁与物理复位扫尾...');
      teardownTestbed();
      console.log('\n[主控] 磁盘清理智能体能力评测周期已全部结束。\n');
      process.exit(code || 0);
    }
  });

  // 4. 监听意外退出与强制中止信号以保证一键复位
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) {
    process.on(signal, () => {
      console.log(`\n[主控] 捕获到中止信号 ${signal}，正在强行清场并复位环境...`);
      if (lockProcess) {
        lockProcess.kill();
      }
      agentProcess.kill();
      teardownTestbed();
      process.exit(1);
    });
  }
}

// 支持 TSX 直接一键运行入口
if (process.argv[1] && process.argv[1].endsWith('run_testbed.ts')) {
  runTestbed();
}
