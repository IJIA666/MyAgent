/**
 * 终端组件门面。
 * 核心职责：
 * 1. 汇集安全网关、配置持久化、人工确认交互和底层执行引擎；
 * 2. 编排生成完整的终端工具执行流生命周期。
 */

import { validateCommand, validateCwd } from './terminal-guard.js';
import { runCommandEngine } from './terminal-engine.js';

/**
 * 终端指令执行核心入口（集成沙箱隔离、流式截断、自动后台化及人工交互确认等高级机制）
 * @param command 要执行的命令行
 * @param cwd 命令启动的目录（相对/绝对，会自动锁死在工作区安全区内）
 * @param isBackground 是否显式启动为后台驻留任务
 * @param options 超时配置选项
 * @returns 执行结果摘要以及带有 <shell_metadata> 的元数据文本
 */
export async function executeCommandTool(
  command: string,
  cwd?: string,
  isBackground?: boolean,
  options?: { timeoutMs?: number; noOutputTimeoutMs?: number }
): Promise<string> {
  // 1. 安全网关：校验复合拼接符与命令注入风险
  validateCommand(command);

  // 2. 沙箱隔离：校验 cwd 范围并获取规范绝对路径
  const targetCwd = validateCwd(cwd);

  // 3. 进程执行：交给底座无状态进程引擎进行 spawn 调度
  return runCommandEngine(command, targetCwd, isBackground, options);
}

// 导出配置管理与进程引擎相关的公共类型及工具函数

export {
  WorkMode,
  getWorkMode,
  setWorkMode,
  loadWorkMode,
  saveWorkMode,
  loadAllowedCommands,
  saveAllowedCommands,
  extractSafePrefix,
  checkWhitelist
} from './terminal-config.js';

export {
  TaskInfo,
  activeTasks
} from './terminal-engine.js';
