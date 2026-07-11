/**
 * 终端执行安全防护拦截网关。
 * 核心职责：
 * 1. 基于硬编码正则防御复合连接符与注入式命令；
 * 2. 校验进程的当前工作目录（cwd）在沙箱保护区内的合法边界；
 * 3. 剥离前导环境变量与嵌套外壳（env/sudo/sh/bash等），识别核心子命令。
 */

import { resolve, sep, isAbsolute } from 'path';
import { getAuthorizedDir, getPhysicalRealPath } from '../base.js';
import type { ResolvedShellKind } from './terminal-types.js';

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
 * 当显式传入 shellKind 时，基于已决议的 shell 语义执行校验，不再由 Guard 自行猜壳。
 * @param command - 待校验的原始命令行文本
 * @param shellKind - 可选的已决议 shell family，传入后按对应 shell 语义校验
 */
export function validateCommand(command: string, shellKind?: ResolvedShellKind): void {
  const unboxedCmd = unboxNestedCommand(command, shellKind).trim();
  
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
 * @deprecated 使用 `READONLY_COMMAND_WHITELISTS[shellKind]` 替代。
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

/** PowerShell 只读白名单 */
const POSH_READONLY_WHITELIST: string[] = [
  'git status', 'git diff', 'git log',
  'vitest', 'npm run test', 'npm test',
  'dir', 'ls',
  'wmic logicaldisk',
  'Get-PSDrive',
  'Get-ChildItem', 'Get-Content', 'Select-String',
];

/** POSIX shell 只读白名单 */
const POSIX_READONLY_WHITELIST: string[] = [
  'git status', 'git diff', 'git log',
  'vitest', 'npm run test', 'npm test',
  'ls', 'cat', 'grep', 'head', 'tail', 'wc',
  'find', 'which', 'type', 'echo', 'pwd',
  'node -v', 'npm -v', 'npx -v',
];

/** cmd 只读白名单 */
const CMD_READONLY_WHITELIST: string[] = [
  'git status', 'git diff', 'git log',
  'vitest', 'npm run test', 'npm test',
  'wmic logicaldisk',
  'dir', 'type', 'findstr',
  'echo', 'cd', 'where',
];

/** 按 shell family 分发的只读命令白名单查找表 */
export const READONLY_COMMAND_WHITELISTS: Record<ResolvedShellKind, string[]> = {
  powershell: POSH_READONLY_WHITELIST,
  posix: POSIX_READONLY_WHITELIST,
  cmd: CMD_READONLY_WHITELIST,
};

/** PowerShell 敏感动作及常见写倾向别名正则（包含 del, rm, rd, rmdir, ri, Remove-Item 等） */
const POSH_DANGEROUS_WRITE_REGEX = /\b(Remove-Item|del|rd|rm|rmdir|ri|mv|Move-Item|cp|Copy-Item|Set-Content|Add-Content|Out-File|New-Item|mkdir|md)\b/i;

/** POSIX shell 敏感动作及常见写倾向命令正则（包含 rm, dd, mkfs, chmod, chown, mv, cp, mkdir 等） */
const POSIX_DANGEROUS_WRITE_REGEX = /\b(rm|dd|mkfs|chmod|chown|mv|cp|mkdir|tee|touch|ln|tar|gzip|gunzip|zip|unzip)\b/i;

/** cmd 敏感动作及常见写倾向命令正则（Windows 命令提示符原生命令） */
const CMD_DANGEROUS_WRITE_REGEX = /\b(del|erase|rd|rmdir|ren|rename|move|copy|xcopy|robocopy|mkdir|md|mklink|fsutil|icacls|cacls|takeown|diskpart|format|chkdsk|sfc)\b/i;

/**
 * 按 shell family 分发的危险写操作正则查找表。
 * 旧版 `DANGEROUS_WRITE_COMMAND_REGEX` 已被此表替代，保留导出以兼容旧引用。
 */
export const DANGEROUS_WRITE_PATTERNS: Record<ResolvedShellKind, RegExp> = {
  powershell: POSH_DANGEROUS_WRITE_REGEX,
  posix: POSIX_DANGEROUS_WRITE_REGEX,
  cmd: CMD_DANGEROUS_WRITE_REGEX,
};

/** @deprecated 使用 `DANGEROUS_WRITE_PATTERNS[shellKind]` 替代；默认使用 PowerShell 正则保持向后兼容。 */
export const DANGEROUS_WRITE_COMMAND_REGEX = POSH_DANGEROUS_WRITE_REGEX;

/**
 * 校验命令行安全评级。
 * 按已决议的 shell family 语义执行”宁错杀不放过”的安全降级判定。
 *
 * @param command - 待执行的完整命令行文本
 * @param shellKind - 可选的已决议 shell family；未提供时默认使用 PowerShell 语义（向后兼容）
 * @returns 判定结果：'allow' 表示允许进入白名单规则校验，'ask' 表示强制安全降级到人工确认，不允许进入白名单匹配
 */
export function checkCommandSafetyLevel(command: string, shellKind?: ResolvedShellKind): 'allow' | 'ask' {
  const kind = shellKind ?? 'powershell';
  const trimmed = unboxNestedCommand(command, kind).trim();
  const whitelist = READONLY_COMMAND_WHITELISTS[kind];

  // 1. 特征判定：如果包含任何危险写动作的指令或别名，强制降级为 ask，严禁静默放行
  if (containsDangerousWriteToken(trimmed, kind)) {
    return 'ask';
  }

  // 2. 白名单判定：如果完全吻合或以只读白名单字开头，允许去匹配本地的配置白名单规则
  for (const rule of whitelist) {
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

/** POSIX 毁灭性高危命令黑名单：`rm -rf /`、`dd` 覆写块设备、`mkfs` 格式化、fork bomb 等 */
const POSIX_HARDLINE_REGEX = /\b(rm\s+-(?:[rR][fF]|[fF][rR])\s+(\/|\*|~))|\bdd\s+if=.*of=\/dev\/|\bmkfs\b|\bchmod\s+-[Rr]\s+777\s+\/|\b:\(\)\s*\{/i;

/** PowerShell 毁灭性高危命令黑名单：递归强制删除系统盘、格式化卷、清除磁盘等 */
const POSH_HARDLINE_REGEX = /\b(Remove-Item\s+-Recurse\s+-Force\s+[Cc]:\\|Format-Volume\s+-DriveLetter\s+[Cc]|Clear-Disk\s+-Number)\b/i;

/** cmd 毁灭性高危命令黑名单：强制递归删除系统盘、格式化系统盘、diskpart 等 */
const CMD_HARDLINE_REGEX = /\b(del\s+\/[fF]\s+\/[sS]\s+\/[qQ]\s+[Cc]:\\|format\s+[Cc]:|diskpart)\b/i;

/**
 * 按 shell family 分发的毁灭性高危命令绝对黑名单查找表。
 * 旧版 `HARDLINE_PATTERNS` 已被此表替代，保留导出以兼容旧引用。
 */
export const HARDLINE_PATTERNS_BY_SHELL: Record<ResolvedShellKind, RegExp> = {
  powershell: POSH_HARDLINE_REGEX,
  posix: POSIX_HARDLINE_REGEX,
  cmd: CMD_HARDLINE_REGEX,
};

/** @deprecated 使用 `HARDLINE_PATTERNS_BY_SHELL[shellKind]` 替代；默认使用 POSIX 正则保持最大覆盖。 */
export const HARDLINE_PATTERNS = POSIX_HARDLINE_REGEX;

/**
 * 敏感文件路径模式列表（仅匹配 basename）。
 * 与 ApprovalPolicy 中的 SENSITIVE_FILE_PATTERNS 保持同构。
 */
const SENSITIVE_READ_PATTERNS: RegExp[] = [
  /\.env$/i,
  /\.env\./i,
  /\.ssh[/\\]/i,
  /id_rsa$/i,
  /id_ed25519$/i,
  /\.gitconfig$/i,
  /\.aws[/\\]/i,
  /\.kube[/\\]/i,
  /\.docker[/\\]/i,
  /credentials$/i,
  /secrets[/\\]/i,
];

/** 各 shell family 用于读取文件内容的核心命令列表。 */
const READ_CONTENT_COMMANDS: Record<ResolvedShellKind, RegExp> = {
  posix: /\b(cat|less|more|head|tail|nl|od|xxd)\b/i,
  powershell: /\b(Get-Content|cat|type|gc|Select-String)\b/i,
  cmd: /\b(type|more|findstr)\b/i,
};

/**
 * 检测命令是否存在敏感文件的读取行为。
 * 先验证命令结构为原子只读，再检查操作目标是否涉及敏感路径。
 *
 * @param command - 已解包的核心命令文本
 * @param shellKind - 已决议的 shell family
 * @returns 若命令为只读但目标路径涉及敏感文件则返回 true
 */
export function isSensitiveReadCommand(command: string, shellKind: ResolvedShellKind): boolean {
  const trimmed = command.trim();

  // 1. 必须是只读命令
  const readPattern = READ_CONTENT_COMMANDS[shellKind];
  if (!readPattern.test(trimmed)) {
    return false;
  }

  // 2. 提取路径参数（命令后的第一个非选项参数）
  const parts = trimmed.split(/\s+/).filter(p => p.length > 0);
  const pathArg = parts.find(p => !p.startsWith('-'));
  if (!pathArg) {
    return false;
  }

  // 3. 检查路径是否落入敏感模式
  const cleanedPath = pathArg.replace(/^['"`]|['"`]$/g, '');
  for (const pattern of SENSITIVE_READ_PATTERNS) {
    if (pattern.test(cleanedPath)) {
      return true;
    }
  }

  return false;
}

/**
 * 校验命令行是否命中绝对黑名单。
 * Git 阻断规则跨 shell 通用保持不变，毁灭级命令跨所有 shell family 做最大安全覆盖。
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
  return isDangerousGitCommand(unboxed);
}

/**
 * Plan 模式下的统一安全判定函数。
 * 确保前置安全评级与执行期结构校验（{@link validateCommand}）在允许集合上严格同构。
 *
 * **同构约束（复用 validateCommand 的结构校验）**：
 * Plan 模式的前置通过集合必须与执行期 {@link validateCommand} 的实际允许集合保持一致，
 * 否则会出现"审批通过但执行失败"的假阳性，或"执行期可通过但前置被误杀"的假阴性。
 *
 * 判定条件（全部满足才返回 true）：
 * 1. 在当前已决议 shell family 下命中只读白名单前缀（{@link checkCommandSafetyLevel} 返回 'allow'）
 * 2. 未命中绝对黑名单（{@link isHardlineDangerous} 返回 false）
 * 3. 能通过 {@link validateCommand} 的结构安全校验（含引号感知与原子命令约束）
 *
 * @param command - 待判定的原始命令行文本
 * @param shellKind - 可选的已决议 shell family；未提供时默认按 PowerShell 语义判定
 * @returns 若命令可静态证明为安全的只读查询则返回 true，否则返回 false
 */
export function isPlanSafeCommand(command: string, shellKind?: ResolvedShellKind): boolean {
  const effectiveShellKind = shellKind ?? 'powershell';
  const commandForSafetyCheck = command.trim();

  // 1. 只允许当前已决议 shell family 下真实可执行的只读命令进入审批
  if (checkCommandSafetyLevel(commandForSafetyCheck, effectiveShellKind) !== 'allow') {
    return false;
  }

  // 2. 排除毁灭级命令（isHardlineDangerous 内部已跨所有 shell family 检查）
  if (isHardlineDangerous(command, effectiveShellKind)) {
    return false;
  }

  // 3. 复用执行期结构校验，确保引号感知与原子命令约束完全同构
  try {
    validateCommand(commandForSafetyCheck, effectiveShellKind);
  } catch {
    return false;
  }

  return true;
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

/** 仅按首个真实命令 token 判定写操作，避免把只读参数误伤为危险命令。 */
export function containsDangerousWriteToken(command: string, shellKind: ResolvedShellKind): boolean {
  const unboxed = unboxNestedCommand(command, shellKind).trim();
  const parts = unboxed.split(/\s+/).map(part => part.replace(/^['"`]|['"`]$/g, ''));
  const executable = parts.find(part => part.length > 0 && !isShellOptionToken(part, shellKind));
  if (!executable) {
    return false;
  }

  const normalized = executable.replace(/\\|\//g, sep).split(sep).pop() || executable;
  return DANGEROUS_WRITE_PATTERNS[shellKind].test(normalized);
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

