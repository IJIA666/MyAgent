/**
 * 终端交互控制模块。
 * 核心职责：
 * 1. 在非安全放行状态下调起控制台请求用户手动确认；
 * 2. 提供全局 Promise 串行化交互队列，防止多个并发提问争抢 stdin。
 */

import readline from 'readline';

/**
 * 全局提问交互队列，用于排队处理并发提问，防止 stdin 资源争抢
 */
let interactionQueue: Promise<unknown> = Promise.resolve();

/**
 * 控制台询问确认交互逻辑（自带全局串行化队列）
 * @param command 待执行命令
 * @param allowedPrefix 静态安全前缀
 * @returns 用户选择的策略 (once: 单次执行, always: 始终放行前缀, deny: 拒绝)
 */
export function askUserPermission(command: string, allowedPrefix: string | null): Promise<'once' | 'always' | 'deny'> {
  const nextInteraction = () => {
    return new Promise<'once' | 'always' | 'deny'>((resolve) => {
      // 针对非 TTY 环境（如测试），默认执行单次放行，避免产生无限挂起
      if (!process.stdin.isTTY) {
        resolve('once');
        return;
      }

      // 创建 readline 实例进行终端 IO 交互
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      console.log(`\n⚠️  [安全提示] Agent 企图执行以下终端命令：`);
      console.log(`   👉  \x1b[33m${command}\x1b[0m`);
      
      if (allowedPrefix) {
        console.log(`选择操作:`);
        console.log(`  [1] 单次放行 (Allow Once)`);
        console.log(`  [2] 始终放行该前缀命令 (Always Allow "${allowedPrefix}:*")`);
        console.log(`  [3] 拒绝执行 (Deny)`);
        
        const ask = () => {
          rl.question(`请选择 [1/2/3]: `, (answer) => {
            const ans = answer.trim();
            if (ans === '1') {
              rl.close();
              resolve('once');
            } else if (ans === '2') {
              rl.close();
              resolve('always');
            } else if (ans === '3') {
              rl.close();
              resolve('deny');
            } else {
              console.log(`无效选择，请重新输入。`);
              ask();
            }
          });
        };
        ask();
      } else {
        console.log(`选择操作:`);
        console.log(`  [1] 单次放行 (Allow Once)`);
        console.log(`  [2] 拒绝执行 (Deny)`);
        
        const ask = () => {
          rl.question(`请选择 [1/2]: `, (answer) => {
            const ans = answer.trim();
            if (ans === '1') {
              rl.close();
              resolve('once');
            } else if (ans === '2') {
              rl.close();
              resolve('deny');
            } else {
              console.log(`无效选择，请重新输入。`);
              ask();
            }
          });
        };
        ask();
      }
    });
  };

  // 将当前的交互请求串行追加到全局提问队列尾部
  const resultPromise = interactionQueue.then(nextInteraction);
  
  // 更新全局队列状态引用，捕获异常以防后续交互卡死
  interactionQueue = resultPromise.catch(() => {});
  
  return resultPromise;
}
