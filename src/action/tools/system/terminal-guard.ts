/**
 * 终端执行安全防护拦截网关。
 * 核心职责：
 * 1. 基于硬编码正则防御复合连接符与注入式命令；
 * 2. 校验进程的当前工作目录（cwd）在沙箱保护区内的合法边界。
 */

import { resolve, sep } from 'path';
import { getAuthorizedDir, getPhysicalRealPath } from '../base.js';

/**
 * 基于硬编码的正则表达式，防止复合命令（反重定向、反命令拼接注入等）
 * 只允许原子的终端命令执行
 */
const COMPOSITE_REGEX = /[&|<>^%\r\n]/;

/**
 * 校验待执行命令的结构安全性
 * @param command - 待校验的命令行文本
 */
export function validateCommand(command: string): void {
  if (COMPOSITE_REGEX.test(command)) {
    throw new Error('拒绝执行：检测到非法的复合连接符或重定向符。终端工具仅支持原子命令。');
  }
}

/**
 * 校验并解析 cwd 路径安全边界
 * 强制保证命令执行的当前工作目录锁定在授权工作区沙箱内部，防范路径逃逸风险。
 * @param cwd - 用户输入的相对或绝对子目录路径
 * @returns 解析清洗后的安全物理绝对路径
 */
export function validateCwd(cwd?: string): string {
  const rootDir = getAuthorizedDir();
  if (!rootDir) {
    throw new Error('工作区路径未初始化。');
  }
  
  // 拼接并物理标准化 targetCwd 绝对路径，展开物理符号链接以防逃逸
  const rawCwd = cwd ? resolve(rootDir, cwd) : rootDir;
  const targetCwd = getPhysicalRealPath(rawCwd);
  
  // 严格沙箱校验：目标路径必须为工作区本身，或是工作区下的直接/间接子文件/夹
  const isAuthorized = targetCwd === rootDir || targetCwd.startsWith(rootDir + sep);
  if (!isAuthorized) {
    throw new Error('Operation not permitted (Out of bounds)');
  }
  
  return targetCwd;
}

/** 明确安全的无副作用只读白名单命令字开头（不能带有管道符及写重定向符号） */
export const READONLY_COMMAND_WHITELIST = [
  'git status',
  'git diff',
  'git log',
  'vitest',
  'npm run test',
  'npm test',
  'dir',
  'ls'
];

/** Windows PowerShell 敏感动作及常见写倾向别名正则（包含 del, rm, rd, rmdir, ri, Remove-Item 等） */
export const DANGEROUS_WRITE_COMMAND_REGEX = /\b(Remove-Item|del|rd|rm|rmdir|ri|mv|Move-Item|cp|Copy-Item|Set-Content|Add-Content|Out-File|New-Item|mkdir|md)\b/i;

/**
 * 校验命令行安全评级。
 * 针对 Windows/PowerShell 执行环境执行“宁错杀不放过”的安全降级判定。
 * 
 * @param command - 待执行的完整命令行文本
 * @returns 判定结果：'allow' 表示静默放行，'ask' 表示强制安全降级到人工确认
 */
export function checkCommandSafetyLevel(command: string): 'allow' | 'ask' {
  const trimmed = command.trim();
  
  // 1. 特征判定：如果包含任何危险删除/写动作的指令或别名，强制降级为 ask
  if (DANGEROUS_WRITE_COMMAND_REGEX.test(trimmed)) {
    return 'ask';
  }
  
  // 2. 白名单判定：如果完全吻合或以只读白名单字开头，允许静默放行
  for (const rule of READONLY_COMMAND_WHITELIST) {
    if (trimmed === rule || trimmed.startsWith(rule + ' ')) {
      return 'allow';
    }
  }
  
  // 3. 安全退路：任何未被识别为绝对安全只读的命令，默认一律降级为 ask
  return 'ask';
}

