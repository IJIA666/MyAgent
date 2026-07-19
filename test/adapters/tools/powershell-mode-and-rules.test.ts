/**
 * PowerShell 模式与规则建议测试。
 * 验证模式放行必须经过安全和路径 guard，规则建议不扩大动态或复杂结构权限。
 */

import { describe, expect, it } from 'vitest';
import { PowerShellAstParser } from '../../../src/adapters/tools/impl/system/command-analysis/powershell-ast-parser.js';
import { validatePowerShellPermissionMode } from '../../../src/adapters/tools/impl/system/command-analysis/powershell-mode-validation.js';
import { validatePowerShellPaths } from '../../../src/adapters/tools/impl/system/command-analysis/powershell-path-validation.js';
import { createPowerShellRuleSuggestions } from '../../../src/adapters/tools/impl/system/command-analysis/powershell-rule-suggestion.js';
import { validatePowerShellSecurity } from '../../../src/adapters/tools/impl/system/command-analysis/powershell-security.js';
import { PermissionRuleStore } from '../../../src/core/domain/permissions/rule-store.js';
import type {
  PowerShellProgramSyntax,
  PowerShellSecurityFlags,
} from '../../../src/adapters/tools/impl/system/command-analysis/types.js';

/** 全文件共享解析器，复用相同输入的 AST 结果。 */
const powershellParser = new PowerShellAstParser();

/** 解析模式和规则测试需要的 PowerShell 投影。 */
async function parseInput(command: string): Promise<{
  program: PowerShellProgramSyntax;
  flags: PowerShellSecurityFlags;
}> {
  const parsed = await powershellParser.parse(command);
  if (!parsed.powershellProgram || !parsed.powershellSecurity) {
    throw new Error(`测试命令未产生完整 PowerShell AST：${command}`);
  }
  return { program: parsed.powershellProgram, flags: parsed.powershellSecurity };
}

describe('PowerShell 模式与规则建议', () => {
  it('acceptEdits 仅放行通过安全与路径检查的简单编辑', async () => {
    const command = 'Set-Content .\\result.txt value';
    const { program, flags } = await parseInput(command);
    const security = validatePowerShellSecurity(program, flags);
    const paths = validatePowerShellPaths(program, 'D:\\projects\\MyAgent', new PermissionRuleStore());

    expect(validatePowerShellPermissionMode('acceptEdits', program, security, paths)).toMatchObject({
      behavior: 'allow',
      code: 'powershell.mode-accept-edits',
    });
  });

  it.each([
    'Set-Content $target value',
    'Remove-Item C:\\ -Recurse -Force',
    'Start-Process notepad.exe',
  ])('acceptEdits 不覆盖动态路径、不可绕过边界或进程执行：%s', async command => {
    const { program, flags } = await parseInput(command);
    const security = validatePowerShellSecurity(program, flags);
    const paths = validatePowerShellPaths(program, 'D:\\projects\\MyAgent', new PermissionRuleStore());

    expect(validatePowerShellPermissionMode('acceptEdits', program, security, paths).behavior).toBe('passthrough');
  });

  it('为稳定外部命令只生成一个有限子命令前缀', async () => {
    const command = 'vssadmin list shadowstorage /for=c:';
    const { program } = await parseInput(command);

    expect(createPowerShellRuleSuggestions(command, program, [])).toEqual([
      'vssadmin list shadowstorage *',
    ]);
  });

  it.each([
    'dism /online /cleanup-image /analyzecomponentstore',
    'Get-ChildItem *.txt',
    'Get-ChildItem . | ForEach-Object { $_.Name }',
    "Get-ChildItem .\nSelect-Object Name",
  ])('禁止为不稳定或明确受限的结构生成规则建议：%s', async command => {
    const { program } = await parseInput(command);
    const codes = command.includes('ForEach-Object') ? ['powershell.script-block'] : [];

    expect(createPowerShellRuleSuggestions(command, program, codes)).toEqual([]);
  });
});
