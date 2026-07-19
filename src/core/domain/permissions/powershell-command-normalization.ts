/**
 * 提供 PowerShell 权限规则使用的命令名规范化。
 * 规则生成与规则匹配共享同一份别名表，避免两端语义漂移。
 */

/** PowerShell 常用别名到规范 cmdlet 名称的映射。 */
const POWERSHELL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  cp: 'copy-item',
  cat: 'get-content',
  cd: 'set-location',
  del: 'remove-item',
  dir: 'get-childitem',
  echo: 'write-output',
  gc: 'get-content',
  gci: 'get-childitem',
  gps: 'get-process',
  ls: 'get-childitem',
  md: 'new-item',
  move: 'move-item',
  mv: 'move-item',
  ni: 'new-item',
  pwd: 'get-location',
  ri: 'remove-item',
  rm: 'remove-item',
  rmdir: 'remove-item',
  type: 'get-content',
  where: 'where-object',
});

/**
 * 查询 PowerShell 别名对应的规范命令名。
 *
 * @param rawName - 原始命令名
 * @returns 规范命令名；不是已知别名时返回 undefined
 */
export function resolvePowerShellAlias(rawName: string): string | undefined {
  return POWERSHELL_ALIASES[rawName.replace(/^['"]|['"]$/g, '').toLowerCase()];
}

/**
 * 规范 PowerShell 权限内容开头的命令名。
 * 其余参数保持原样，后续匹配阶段再负责大小写和通配符语义。
 *
 * @param content - 权限规则或实际原子命令
 * @returns 规范化后的权限内容
 */
export function normalizePowerShellCommandContent(content: string): string {
  const match = /^(\s*)([^\s|;&]+)([\s\S]*)$/.exec(content);
  if (!match) {
    return content;
  }
  const canonicalName = resolvePowerShellAlias(match[2]) ?? match[2].toLowerCase();
  return `${match[1]}${canonicalName}${match[3]}`;
}
