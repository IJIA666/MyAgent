/**
 * 终端执行安全防护拦截网关。
 * 核心职责：
 * 1. 基于硬编码正则防御复合连接符与注入式命令；
 * 2. 校验进程的当前工作目录（cwd）在沙箱保护区内的合法边界。
 */

import { resolve, sep } from 'path';
import { getAuthorizedDir } from './base.js';

/**
 * 基于硬编码的正则表达式，防止复合命令（反重定向、反命令拼接注入等）
 * 只允许原子的终端命令执行
 */
const COMPOSITE_REGEX = /[&|<>^%\r\n]/;

/**
 * 校验待执行命令的结构安全性
 * @param command 待校验的命令行文本
 */
export function validateCommand(command: string): void {
  if (COMPOSITE_REGEX.test(command)) {
    throw new Error('拒绝执行：检测到非法的复合连接符或重定向符。终端工具仅支持原子命令。');
  }
}

/**
 * 校验并解析 cwd 路径安全边界
 * 强制保证命令执行的当前工作目录锁定在授权工作区沙箱内部，防范路径逃逸风险。
 * @param cwd 用户输入的相对或绝对子目录路径
 * @returns 解析清洗后的安全物理绝对路径
 */
export function validateCwd(cwd?: string): string {
  const rootDir = getAuthorizedDir();
  if (!rootDir) {
    throw new Error('工作区路径未初始化。');
  }
  
  // 拼接并规范化 targetCwd 绝对路径
  const targetCwd = cwd ? resolve(rootDir, cwd) : rootDir;
  
  // 严格沙箱校验：目标路径必须为工作区本身，或是工作区下的直接/间接子文件/夹
  const isAuthorized = targetCwd === rootDir || targetCwd.startsWith(rootDir + sep);
  if (!isAuthorized) {
    throw new Error('Operation not permitted (Out of bounds)');
  }
  
  return targetCwd;
}
