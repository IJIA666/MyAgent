/**
 * 终端执行安全防护拦截网关。
 * 核心职责：
 * 1. 基于硬编码正则防御复合连接符与注入式命令；
 * 2. 校验进程的当前工作目录（cwd）在沙箱保护区内的合法边界；
 * 3. 剥离前导环境变量与嵌套外壳（env/sudo/sh/bash等），识别核心子命令。
 */

import { resolve, sep, isAbsolute } from 'path';
import { getAuthorizedDir, getPhysicalRealPath } from '../base.js';

/**
 * 基于硬编码的正则表达式，防止复合命令（反重定向、反命令拼接注入等）
 * 只允许原子的终端命令执行
 */
export const COMPOSITE_REGEX = /[;&|<>^%`\r\n]|\$\(|\\\(/;

/** 安全网关检测的单字符拼接与重定向元字符集合 */
export const COMPOSITE_CHARS = [';', '&', '|', '<', '>', '^', '%', '\r', '\n'];

/**
 * 校验待执行命令的结构安全性
 * 内部首先自动调用 unboxNestedCommand 进行防御性解包，并进行引号感知的拼接注入扫描。
 * @param command - 待校验的原始命令行文本
 */
export function validateCommand(command: string): void {
  const unboxedCmd = unboxNestedCommand(command).trim();
  
  // 0. Git 变更写操作绝对阻断检验
  if (isDangerousGitCommand(unboxedCmd)) {
    throw new Error('拒绝执行：严禁执行除只读查看外的任何 Git 变更操作。');
  }
  
  // 1. 引号平衡性前置检验（防不平衡单/双引号闭合逃逸）
  let doubleQuoteCount = 0;
  let singleQuoteCount = 0;
  let escaped = false;
  
  for (let i = 0; i < unboxedCmd.length; i++) {
    const char = unboxedCmd[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      doubleQuoteCount++;
    } else if (char === "'") {
      singleQuoteCount++;
    }
  }
  
  if (doubleQuoteCount % 2 !== 0 || singleQuoteCount % 2 !== 0) {
    throw new Error('拒绝执行：检测到不平衡的引号结构，可能存在注入绕过风险。');
  }

  // 2. 逐字符状态机遍历
  let inSingleQuote = false;
  let inDoubleQuote = false;
  escaped = false;

  for (let i = 0; i < unboxedCmd.length; i++) {
    const char = unboxedCmd[i];

    // 处理转义字符
    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      if (!inSingleQuote) {
        // 如果在 unquoted 下，且下一个字符是 '('，则属于被禁止的命令替换转义 '\('
        if (!inDoubleQuote && i + 1 < unboxedCmd.length && unboxedCmd[i + 1] === '(') {
          throw new Error('拒绝执行：检测到非法的转义命令替换符 \\(。');
        }
        escaped = true;
        continue;
      }
    }

    // 处理引号状态切换
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    // 安全设计决策：反引号在双引号内（如 "echo `whoami`"）在 Bash/PowerShell 中仍然会被当作命令替换执行，
    // 因此只有在单引号内反引号才是安全字面量。此处只要不在单引号内，遇到反引号一律强制阻断拦截。
    if (char === '`' && !inSingleQuote) {
      throw new Error("拒绝执行：检测到非法的反引号命令替换符 '`'。");
    }

    // 若当前处于任何引号包裹中，其内的拼接符均安全避让
    if (inSingleQuote || inDoubleQuote) {
      continue;
    }

    // 处于 unquoted 状态下，拦截命令替换 $(
    if (char === '$' && i + 1 < unboxedCmd.length && unboxedCmd[i + 1] === '(') {
      throw new Error('拒绝执行：检测到非法的命令替换符 $(。');
    }

    // 检测单字符拼接/重定向符：; & | < > ^ % \r \n (使用模块常量 COMPOSITE_CHARS 以消除迭代内存分配)
    if (COMPOSITE_CHARS.includes(char)) {
      throw new Error(`拒绝执行：检测到非法的复合连接符或重定向符 '${char}'。终端工具仅支持原子命令。`);
    }
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

/**
 * 明确安全的无副作用只读白名单命令字开头（不能带有管道符及写重定向符号）
 */
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
 * @returns 判定结果：'allow' 表示允许进入白名单规则校验，'ask' 表示强制安全降级到人工确认，不允许进入白名单匹配
 */
export function checkCommandSafetyLevel(command: string): 'allow' | 'ask' {
  const trimmed = command.trim();
  
  // 1. 特征判定：如果包含任何危险写动作的指令或别名，强制降级为 ask，严禁静默放行
  if (DANGEROUS_WRITE_COMMAND_REGEX.test(trimmed)) {
    return 'ask';
  }
  
  // 2. 白名单判定：如果完全吻合或以只读白名单字开头，允许去匹配本地的配置白名单规则
  for (const rule of READONLY_COMMAND_WHITELIST) {
    if (trimmed === rule || trimmed.startsWith(rule + ' ')) {
      return 'allow';
    }
  }
  
  // 3. 安全退路：任何未被识别为绝对安全只读的命令，默认一律降级为 ask
  return 'ask';
}

/** 非只读 Git 写/变更操作正则 */
export const DANGEROUS_GIT_WRITE_REGEX = /\b(add|commit|checkout|reset|push|pull|rebase|merge|stash|revert)\b/i;

/**
 * 校验 unboxed 核心命令是否属于高危的非只读 Git 变更操作。
 * 
 * @param unboxedCmd - 已经剥除嵌套外壳的核心命令行文本
 * @returns 若命中非只读 Git 变更操作则返回 true，否则返回 false
 */
export function isDangerousGitCommand(unboxedCmd: string): boolean {
  const parts = unboxedCmd.split(/\s+/);
  if (parts.length < 2) {
    return false;
  }
  if (parts[0].toLowerCase() !== 'git') {
    return false;
  }

  // 扫描 Git 子命令，跳过全局配置标志以精准判定首个真实子命令
  let i = 1;
  while (i < parts.length) {
    const part = parts[i];
    // 跳过 -c 和 -C 及其后面的对应参数值
    if (part === '-c' || part === '-C') {
      i += 2;
      continue;
    }
    // 跳过其他形式 of 全局 flags
    if (part.startsWith('-')) {
      i++;
      continue;
    }
    
    // 取得清除引号包裹后的子命令
    const cleanSub = part.replace(/['"`]/g, '').toLowerCase();
    if (DANGEROUS_GIT_WRITE_REGEX.test(cleanSub)) {
      return true;
    }
    break;
  }
  return false;
}

/** 毁灭性高危命令的底层硬底盘黑名单（即使在 YOLO 模式下也必须绝对阻断执行，包含毁灭级删除、块设备覆写与磁盘格式化） */
export const HARDLINE_PATTERNS = /\b(rm\s+-(?:[rR][fF]|[fF][rR])\s+(\/|\*|~)|\bdd\s+if=.*of=\/dev\/|\bmkfs\b)/i;

/**
 * 校验命令行是否命中绝对黑名单。
 *
 * @param command - 待执行的命令行文本
 * @returns 如果命中绝对黑名单则返回 true，否则返回 false
 */
export function isHardlineDangerous(command: string): boolean {
  const unboxed = unboxNestedCommand(command).trim();
  if (HARDLINE_PATTERNS.test(unboxed)) {
    return true;
  }
  return isDangerousGitCommand(unboxed);
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
 * 
 * @param command - 干净的命令文本
 * @returns 剥离嵌套后的核心指令内容
 */
export function unboxNestedCommand(command: string): string {
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

/**
 * 分析命令行，检测敏感词和潜在的安全跨盘逃逸，生成 Advisory Warnings。
 * 
 * @param command - 原始命令行
 * @returns 警告信息数组，若无则返回空数组
 */
export function detectAdvisoryWarnings(command: string): string[] {
  const warnings: string[] = [];
  
  const unboxed = unboxNestedCommand(command);
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

