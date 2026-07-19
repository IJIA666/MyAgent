/**
 * Shell 权限行为夹具。
 * 夹具只描述 MyAgent 的输入和预期结果，不携带外部实现或版本信息。
 */

/** 单条 Shell 权限行为夹具。 */
export interface ShellPermissionFixture {
  /** 夹具名称。 */
  readonly name: string;
  /** 使用的固定 Shell 工具。 */
  readonly toolName: 'Bash' | 'PowerShell';
  /** 原始命令文本。 */
  readonly command: string;
  /** 预期候选行为。 */
  readonly expectedKind: 'allow' | 'ask' | 'deny';
  /** 是否预期提供至少一条可复用规则。 */
  readonly expectsRuleSuggestion: boolean;
}

/** 第一批稳定的 Shell 权限行为夹具。 */
export const SHELL_PERMISSION_FIXTURES: readonly ShellPermissionFixture[] = [
  {
    name: 'PowerShell 普通只读管道',
    toolName: 'PowerShell',
    command: 'Get-Content package.json | Select-String "scripts"',
    expectedKind: 'allow',
    expectsRuleSuggestion: false,
  },
  {
    name: 'PowerShell 单行脚本块',
    toolName: 'PowerShell',
    command: 'Get-ChildItem . | ForEach-Object { $_.Name }',
    expectedKind: 'ask',
    expectsRuleSuggestion: false,
  },
  {
    name: 'PowerShell 多行脚本块',
    toolName: 'PowerShell',
    command: 'Get-ChildItem . | ForEach-Object {\n  $_.Name\n}',
    expectedKind: 'ask',
    expectsRuleSuggestion: false,
  },
  {
    name: 'PowerShell 系统维护命令',
    toolName: 'PowerShell',
    command: 'dism /online /cleanup-image /analyzecomponentstore | Select-String "component store"',
    expectedKind: 'ask',
    expectsRuleSuggestion: false,
  },
  {
    name: 'PowerShell 危险嵌套删除',
    toolName: 'PowerShell',
    command: 'Get-ChildItem . | ForEach-Object { Remove-Item C:\\ -Recurse -Force }',
    expectedKind: 'deny',
    expectsRuleSuggestion: false,
  },
  {
    name: 'PowerShell 可复用未知系统查询',
    toolName: 'PowerShell',
    command: 'vssadmin list shadowstorage',
    expectedKind: 'ask',
    expectsRuleSuggestion: true,
  },
  {
    name: 'Bash 普通只读复合命令',
    toolName: 'Bash',
    command: 'git status && git log -1',
    expectedKind: 'allow',
    expectsRuleSuggestion: false,
  },
  {
    name: 'Bash 复合命令中的危险删除',
    toolName: 'Bash',
    command: 'git status && rm -rf /',
    expectedKind: 'deny',
    expectsRuleSuggestion: false,
  },
  {
    name: 'Bash 动态代码执行',
    toolName: 'Bash',
    command: 'node -e "console.log(1)"',
    expectedKind: 'ask',
    expectsRuleSuggestion: false,
  },
];
