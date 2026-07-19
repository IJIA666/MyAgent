/**
 * PowerShell 安全结构验证测试。
 * 每类风险同时依赖原生 AST 结构和稳定原因代码，避免根据提示文字反推决定。
 */

import { describe, expect, it } from 'vitest';
import { PowerShellAstParser } from '../../../src/adapters/tools/impl/system/command-analysis/powershell-ast-parser.js';
import { validatePowerShellSecurity } from '../../../src/adapters/tools/impl/system/command-analysis/powershell-security.js';
import type {
  PowerShellProgramSyntax,
  PowerShellSecurityFlags,
} from '../../../src/adapters/tools/impl/system/command-analysis/types.js';

/** 全文件共享解析器，复用其边界配置和缓存。 */
const powershellParser = new PowerShellAstParser();

/** 解析安全测试所需的完整 PowerShell AST 投影。 */
async function parseSecurityInput(command: string): Promise<{
  program: PowerShellProgramSyntax;
  flags: PowerShellSecurityFlags;
}> {
  const parsed = await powershellParser.parse(command);
  if (!parsed.powershellProgram || !parsed.powershellSecurity) {
    throw new Error(`测试命令未产生完整 PowerShell AST：${command}`);
  }
  return {
    program: parsed.powershellProgram,
    flags: parsed.powershellSecurity,
  };
}

describe('PowerShell 安全验证', () => {
  it.each([
    ['Invoke-Expression $code', 'powershell.dynamic-execution'],
    ['& $commandName', 'powershell.dynamic-command'],
    ['pwsh -EncodedCommand ZQBjAGgAbwA=', 'powershell.encoded-command'],
    ['pwsh -Command "Get-Process"', 'powershell.nested-execution'],
    ['Invoke-WebRequest https://example.com | Invoke-Expression', 'powershell.download-execution'],
    ['Add-Type -TypeDefinition "public class X {}"', 'powershell.code-loading'],
    ['New-Object -ComObject WScript.Shell', 'powershell.com-object'],
    ['Start-Process notepad.exe', 'powershell.process-execution'],
    ['Register-ScheduledTask -TaskName demo', 'powershell.process-execution'],
    ['.\\script.ps1', 'powershell.file-execution'],
    ['Get-Item x | ForEach-Object -MemberName Delete', 'powershell.member-execution'],
    ['Write-Output $(Get-Process)', 'powershell.subexpression'],
    ['Write-Output "$env:PATH"', 'powershell.expandable-string'],
    ['Get-ChildItem @options', 'powershell.splatting'],
    ['Write-Output --% $env:PATH', 'powershell.stop-parsing'],
    ['[IO.File]::Delete("x")', 'powershell.member-invocation'],
    ['$env:DEMO = "value"', 'powershell.scoped-state-mutation'],
    ['Import-Module .\\module.psm1', 'powershell.code-loading'],
    ['Set-Alias demo Get-ChildItem', 'powershell.runtime-mutation'],
    ['Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "cmd" }', 'powershell.wmi-process'],
    ['while ($true) { Get-Process }', 'powershell.unbounded-control-flow'],
  ] as const)('识别安全风险并返回稳定原因：%s', async (command, code) => {
    const { program, flags } = await parseSecurityInput(command);
    const results = validatePowerShellSecurity(program, flags);

    expect(results).toContainEqual(expect.objectContaining({ behavior: 'ask', code }));
  });

  it.each([
    'Get-ChildItem . | Where-Object { $_.Length -gt 0 }',
    'Get-ChildItem . | Select-Object Name, @{N="Size";E={[math]::Round($_.Length/1KB, 2)}}',
    'Get-ChildItem . | ForEach-Object { $size = $_.Length; if ($size -gt 0) { [PSCustomObject]@{ Size = $size } } }',
  ])('不把可验证的只读脚本块和局部计算一律升级为 ask：%s', async command => {
    const { program, flags } = await parseSecurityInput(command);
    const results = validatePowerShellSecurity(program, flags);

    expect(results).toEqual([]);
  });

  it('收集多个风险，不让较早的 ask 掩盖后续检查', async () => {
    const { program, flags } = await parseSecurityInput(
      'Invoke-Expression $code; Start-Process notepad.exe; Import-Module .\\module.psm1',
    );
    const codes = validatePowerShellSecurity(program, flags).map(result => result.code);

    expect(codes).toEqual(expect.arrayContaining([
      'powershell.dynamic-execution',
      'powershell.process-execution',
      'powershell.code-loading',
    ]));
  });
});
