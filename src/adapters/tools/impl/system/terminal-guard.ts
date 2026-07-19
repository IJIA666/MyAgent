/**
 * 终端执行安全防护拦截网关。
 * 核心职责：
 * 1. 对毁灭级命令提供执行期硬红线兜底；
 * 2. 校验进程的当前工作目录边界；
 * 3. 剥离前导环境变量与冗余 Shell wrapper，生成非阻断提醒。
 */

import { resolve, sep, isAbsolute } from 'path';
import { getAuthorizedDir, getPhysicalRealPath } from '../base.js';
import type { ResolvedShellKind } from './terminal-types.js';

/**
 * 校验待执行命令的结构安全性。
 * 执行阶段的轻量硬红线检查——权限决策由 checkPermissions 在授权阶段完成，
 * 此处不再重复分析命令结构，仅做运行时 hardline 安全兜底。
 * @param command - 待校验的原始命令行文本
 * @param shellKind - 可选的已决议 shell family，传入后按对应 shell 语义校验
 * @returns 校验完成后的 Promise
 */
export async function validateCommand(
  command: string,
  shellKind?: ResolvedShellKind,
): Promise<void> {
  if (isHardlineDangerous(command, shellKind)) {
    throw new Error('拒绝执行：命令命中硬红线安全规则。');
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

/** POSIX 毁灭性高危命令黑名单：`rm -rf /`、`dd` 覆写块设备、`mkfs` 格式化、fork bomb 等 */
const POSIX_HARDLINE_REGEX = /\b(rm\s+-(?:[rR][fF]|[fF][rR])\s+(\/|\*|~))|\bdd\s+if=.*of=\/dev\/|\bmkfs\b|\bchmod\s+-[Rr]\s+777\s+\/|\b:\(\)\s*\{/i;

/** PowerShell 毁灭性高危命令黑名单：递归强制删除系统盘、格式化卷、清除磁盘等 */
const POSH_HARDLINE_REGEX = /\b(Remove-Item\s+-Recurse\s+-Force\s+[Cc]:\\|Format-Volume\s+-DriveLetter\s+[Cc]|Clear-Disk\s+-Number)\b/i;

/** cmd 毁灭性高危命令黑名单：强制递归删除系统盘、格式化系统盘、diskpart 等 */
const CMD_HARDLINE_REGEX = /\b(del\s+\/[fF]\s+\/[sS]\s+\/[qQ]\s+[Cc]:\\|format\s+[Cc]:|diskpart)\b/i;

/** 按 shell family 分发的毁灭性高危命令绝对黑名单查找表。 */
export const HARDLINE_PATTERNS_BY_SHELL: Record<ResolvedShellKind, RegExp> = {
  powershell: POSH_HARDLINE_REGEX,
  posix: POSIX_HARDLINE_REGEX,
  cmd: CMD_HARDLINE_REGEX,
};

/**
 * 校验命令行是否命中绝对黑名单。
 * 毁灭级命令跨所有 shell family 做最大安全覆盖。
 *
 * @param command - 待执行的命令行文本
 * @param shellKind - 可选的已决议 shell family；未提供时使用 POSIX 正则（最大安全覆盖）
 * @returns 如果命中绝对黑名单则返回 true，否则返回 false
 */
export function isHardlineDangerous(command: string, shellKind?: ResolvedShellKind): boolean {
  const unboxed = unboxNestedCommand(command, shellKind).trim();

  // 跨所有 shell family 做最大安全覆盖：任一 shell 族系的毁灭模式命中即阻断
  for (const kind of ['posix', 'powershell', 'cmd'] as ResolvedShellKind[]) {
    if (HARDLINE_PATTERNS_BY_SHELL[kind].test(unboxed)) {
      return true;
    }
  }
  return false;
}

/**
 * 剔除命令前导的环境变量赋值。
 * 
 * @param command - 原始命令文本
 * @returns 剔除环境变量后的干净命令文本
 */
export function stripLeadingEnvAssignments(command: string): string {
  let trimmed = command.trim();
  const envPattern = /^[a-zA-Z_][a-zA-Z0-9_]*=(?:'[^']*'|"[^"]*"|[^\s'"]+)\s+/;
  while (envPattern.test(trimmed)) {
    trimmed = trimmed.replace(envPattern, '').trim();
  }
  return trimmed;
}

/**
 * 寻找与字符串首位引号成对闭合的未转义引号的索引。
 * 如果找不到或闭合点不在末尾，说明首尾引号并不是包围整个字符串的同一对引号。
 *
 * @param str - 待扫描的命令行文本
 * @returns 闭合引号在字符串中的索引，找不到则返回 -1
 */
function getMatchingQuoteIndex(str: string): number {
  const quote = str[0];
  if (quote !== '"' && quote !== "'" && quote !== '`') {
    return -1;
  }
  let isEscaped = false;
  for (let i = 1; i < str.length; i++) {
    const char = str[i];
    if (isEscaped) {
      isEscaped = false;
      continue;
    }
    if (char === '\\') {
      isEscaped = true;
      continue;
    }
    if (char === quote) {
      return i;
    }
  }
  return -1;
}

/**
 * 递归剥离命令的嵌套外壳（env, sudo, exec, sh, bash等），提取出真正执行的核心命令内容。
 * 当显式传入 shellKind 时，表示上层已决议 shell 语义，不再由 Guard 自行做壳推断，
 * 直接返回原始命令文本。
 *
 * @param command - 干净的命令文本
 * @param shellKind - 可选的已决议 shell family；传入后跳过自动壳推断，直接返回原命令
 * @returns 剥离嵌套后的核心指令内容
 */
export function unboxNestedCommand(command: string, shellKind?: ResolvedShellKind): string {
  if (shellKind) {
    return stripRedundantShellWrapper(command.trim(), shellKind);
  }

  let current = command.trim();

  // 递归剥离前置前缀 env, sudo, exec
  // env 虽为 Unix 命令，但在 Windows 环境下能有效兼容 Git Bash 等类 Unix 模拟终端环境
  const prefixPattern = /^(env|sudo|exec)\s+/i;
  let changed = true;
  while (changed) {
    changed = false;
    const stripped = stripLeadingEnvAssignments(current);
    if (stripped !== current) {
      current = stripped;
      changed = true;
    }
    
    const match = current.match(prefixPattern);
    if (match) {
      current = current.slice(match[0].length).trim();
      changed = true;
    }
  }

  // 改进后的 shellPrefixPattern：支持解释器后附带可选参数，如 -NoProfile -ExecutionPolicy Bypass，且使用 [^\s'"`-]+ 限制其值不能含引号以防吞噬 innerCmd 内的包裹段
  const shellPrefixPattern = /^(sh|bash|cmd|powershell|pwsh)(?:\s+-[a-zA-Z0-9]+(?:\s+[^\s'"`-]+)?)*\s+(?:-c|-Command|\/c)\s+/i;
  const shellMatch = current.match(shellPrefixPattern);
  if (shellMatch) {
    // 采用位置截取，获取匹配头之后的全部剩余字符串，防止正则捕获组在处理复杂的嵌套引号时发生截断
    let innerCmd = current.slice(shellMatch[0].length).trim();
    
    // 剥离最外层的一对包围引号（通过 getMatchingQuoteIndex 判定是否为同一对包裹引号，防止如 "cmd A" --arg "cmd B" 类型的首尾误判）
    const firstChar = innerCmd[0];
    if (firstChar === '"' || firstChar === "'" || firstChar === '`') {
      const matchIndex = getMatchingQuoteIndex(innerCmd);
      if (matchIndex === innerCmd.length - 1) {
        innerCmd = innerCmd.slice(1, -1).trim();
      }
    }
    return unboxNestedCommand(innerCmd);
  }

  // 将 & { ... } 清洗逻辑独立于 shellMatch 外置，以便处理单独传入的脚本块或递归深度清洗（正则确保 & 后紧随 {，防止误伤普通带花括号参数的命令，如 & cmd --config={...}）
  if (/^&\s*\{/.test(current) && current.endsWith('}')) {
    current = current.replace(/^&\s*\{\s*/, '').replace(/\s*\}$/, '').trim();
    return unboxNestedCommand(current);
  }

  return current;
}

/** 剥离与已决议 shell family 相同的冗余 wrapper，避免显式 shell 输入误伤白名单。 */
function stripRedundantShellWrapper(command: string, shellKind: ResolvedShellKind): string {
  const current = command.trim();

  if (shellKind === 'powershell') {
    const commandWrapper = current.match(/^(powershell|pwsh)(?:\.exe)?(?:\s+-[a-zA-Z0-9]+(?:\s+[^\s'"`-]+)?)*\s+(?:-c|-Command)\s+([\s\S]+)$/i);
    if (commandWrapper) {
      return unboxNestedCommand(commandWrapper[2].trim());
    }

    const directWrapper = current.match(/^(powershell|pwsh)(?:\.exe)?\s+([\s\S]+)$/i);
    if (directWrapper) {
      return directWrapper[2].trim();
    }
  }

  if (shellKind === 'cmd') {
    const cmdWrapper = current.match(/^cmd(?:\.exe)?(?:\s+\/[a-zA-Z])*\s+\/[ck]\s+([\s\S]+)$/i);
    if (cmdWrapper) {
      return unboxNestedCommand(cmdWrapper[1].trim());
    }
  }

  if (shellKind === 'posix') {
    const posixWrapper = current.match(/^(sh|bash)(?:\s+-[a-zA-Z0-9]+(?:\s+[^\s'"`-]+)?)*\s+-c\s+([\s\S]+)$/i);
    if (posixWrapper) {
      return unboxNestedCommand(posixWrapper[2].trim());
    }
  }

  return current;
}

/**
 * 分析命令行，检测敏感词和潜在的安全跨盘逃逸，生成 Advisory Warnings。
 * 
 * @param command - 原始命令行
 * @returns 警告信息数组，若无则返回空数组
 */
export function detectAdvisoryWarnings(command: string, shellKind?: ResolvedShellKind): string[] {
  const warnings: string[] = [];
  
  const effectiveShellKind = shellKind ?? 'powershell';
  const unboxed = unboxNestedCommand(command, shellKind);
  const parts = unboxed.split(/\s+/);
  if (parts.length === 0) return [];
  
  const exe = parts[0];
  const exeName = exe.replace(/\\|\//g, sep).split(sep).pop() || '';
  
  // 敏感二进制名检测
  const sensitiveExes = /^(rm|dd|mkfs|format|del|erase|rd|rmdir)$/i;
  if (sensitiveExes.test(exeName)) {
    warnings.push(`检测到敏感系统命令/二进制名: "${exeName}"。已放行，请谨慎操作。`);
  }
  
  // 跨盘防沙箱穿透与绝对路径真实解析校验
  const rootDir = getAuthorizedDir();
  if (rootDir) {
    for (const part of parts.slice(1)) {
      const cleanPart = part.replace(/^['"`]|['"`]$/g, '');
      if (isShellOptionToken(cleanPart, effectiveShellKind)) {
        continue;
      }
      
      // 判断是否是绝对路径或者含有盘符特征
      if (isAbsolute(cleanPart) || /^[a-zA-Z]:\\/.test(cleanPart)) {
        try {
          const resolvedPath = getPhysicalRealPath(cleanPart);
          const rootVolume = rootDir.slice(0, 3).toLowerCase();
          const destVolume = resolvedPath.slice(0, 3).toLowerCase();
          
          if (rootVolume !== destVolume) {
            warnings.push(`检测到跨盘访问或路径逃逸: 试图从工作区盘符 "${rootVolume}" 访问外部路径 "${resolvedPath}"`);
          } else {
            const isInside = resolvedPath === rootDir || resolvedPath.startsWith(rootDir + sep);
            if (!isInside) {
              warnings.push(`检测到工作区外的文件访问: "${resolvedPath}"`);
            }
          }
        } catch {
          // 路径可能不存在或非法，忽略
        }
      }
    }
  }

  return warnings;
}

/** 识别当前 shell family 下的命令开关，避免把参数误判为文件路径。 */
function isShellOptionToken(part: string, shellKind: ResolvedShellKind): boolean {
  if (part.length <= 1) {
    return false;
  }
  if (shellKind === 'cmd') {
    return part.startsWith('/');
  }
  return part.startsWith('-');
}

