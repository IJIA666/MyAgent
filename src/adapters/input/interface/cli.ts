/**
 * 终端界面（CLI）代理层门面。
 * 核心职责：
 * 1. 保持对外的 startCli 与 redrawHistory 签名契约向前兼容；
 * 2. 将控制台按行输入和回回绘视图的行为委托给 CliFacade 和 WidgetRenderer 执行。
 */
import { SessionManager } from '../../../core/usecases/session.js';
import { CliFacade } from './facade.js';
import { 
  renderContentWithWidgets, 
  redrawHistory as redrawHistoryImpl 
} from './views/widget-renderer.js';

import readline from 'readline';
import { theme } from './views/theme.js';

export { renderContentWithWidgets };

/**
 * 阻塞当前异步逻辑，在控制台打印高亮提示信息，等待用户完成手动浏览器操作并在命令行按下回车键后释放。
 * 针对 Readline 实例和 process.stdin 状态进行安全管控，防范流泄露和死锁。
 *
 * @param message - 要在终端展示的提示性文本
 * @returns 异步 Promise，在用户回车后释放阻塞
 */
export function waitUserIntervention(message: string): Promise<void> {
  return new Promise<void>((resolve) => {
    // 打印清晰的黄色高亮指示
    console.log(`\n${theme.intervention(message)}`);

    // 建立临时的独立 Readline 接口实例
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question('   👉  已完成手动操作？按【回车键/Enter】以确认并继续智能体自动操作：', () => {
      // 1. 物理注销 Readline 实例，释放其对 stdin 的流占用
      rl.close();

      // 2. 显式对 stdin 执行 pause 以释放事件监听，防止与主 REPL 抢夺流
      if (process.stdin.isTTY) {
        process.stdin.pause();
      }

      console.log(theme.success('✔ 状态同步完成，智能体继续执行...\n'));
      resolve();
    });
  });
}

/**
 * 兼容原有的 redrawHistory 接口，接受 SessionManager 并将其内部数据转发给无状态渲染工具。
 *
 * @param session - 会话管理器实例
 */
export function redrawHistory(session: SessionManager): void {
  redrawHistoryImpl(session.getHistory(), session.getModelName());
}

/**
 * 初始化并启动基于 readline 的 REPL 交互式解释器。
 * 委托给 CliFacade 执行。
 *
 * @param session - 已在系统启动层装配完毕的会话管理器实例
 */
export function startCli(session: SessionManager): void {
  const facade = new CliFacade(session);
  facade.start();
}

