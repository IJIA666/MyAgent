/**
 * 终端界面（CLI）代理层门面。
 * 核心职责：
 * 1. 保持对外的 startCli 与 redrawHistory 签名契约向前兼容；
 * 2. 将控制台按行输入和回回绘视图的行为委托给 CliFacade 和 WidgetRenderer 执行。
 */
import { SessionManager } from '../brain/index.js';
import { CliFacade } from './facade.js';
import { 
  renderContentWithWidgets, 
  redrawHistory as redrawHistoryImpl 
} from './views/widget-renderer.js';

export { renderContentWithWidgets };

/**
 * 兼容原有的 redrawHistory 接口，接受 SessionManager 并将其内部数据转发给无状态渲染工具。
 * @param session 会话管理器实例
 */
export function redrawHistory(session: SessionManager): void {
  redrawHistoryImpl(session.getHistory(), session.getModelName());
}

/**
 * 初始化并启动基于 readline 的 REPL 交互式解释器。
 * 委托给 CliFacade 执行。
 * @param session 已在系统启动层装配完毕的会话管理器实例
 */
export function startCli(session: SessionManager): void {
  const facade = new CliFacade(session);
  facade.start();
}
