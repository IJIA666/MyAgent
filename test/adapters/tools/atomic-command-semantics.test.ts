/**
 * 原子命令语义契约测试。
 * 覆盖命令身份、参数验证、多维行为和资源 operand，不替代最终权限策略测试。
 */

import { describe, expect, it } from 'vitest';
import { analyzeShellCommand } from '../../../src/adapters/tools/impl/system/command-analysis/index.js';
import { normalizePowerShellParameterName } from '../../../src/adapters/tools/impl/system/command-analysis/powershell-common-parameters.js';
import { resolvePowerShellCommandIdentity } from '../../../src/adapters/tools/impl/system/command-analysis/powershell-command-identity.js';
import { PowerShellAstParser } from '../../../src/adapters/tools/impl/system/command-analysis/powershell-ast-parser.js';
import { validatePowerShellReadOnlyCommand } from '../../../src/adapters/tools/impl/system/command-analysis/powershell-read-only.js';
import type { PowerShellCommandSyntax } from '../../../src/adapters/tools/impl/system/command-analysis/types.js';

/** 解析测试输入中的首个 PowerShell 命令。 */
async function parseFirstPowerShellCommand(command: string): Promise<PowerShellCommandSyntax> {
  const result = await new PowerShellAstParser().parse(command);
  const parsedCommand = result.powershellProgram?.statements
    .flatMap(statement => statement.commands)[0];
  if (!parsedCommand) {
    throw new Error(`测试命令未产生 PowerShell AST：${command}`);
  }
  return parsedCommand;
}

describe('原子命令语义', () => {
  it('为 PowerShell 读取 cmdlet 保留身份、参数和文件 operand', async () => {
    const analysis = await analyzeShellCommand('Get-Content package.json', 'powershell');
    const evidence = analysis.subcommands[0]?.evidence;

    expect(analysis).toMatchObject({ sideEffect: 'read', permission: 'allow' });
    expect(evidence).toMatchObject({
      identity: {
        rawName: 'Get-Content',
        canonicalName: 'get-content',
        kind: 'cmdlet',
        resolutionConfidence: 'syntactic',
      },
      validation: { status: 'validated' },
      possibleEffects: ['filesystemRead'],
      resourceOperands: [
        expect.objectContaining({
          argumentIndex: 0,
          kind: 'filesystem',
          access: 'read',
          rawValue: 'package.json',
          dynamic: false,
        }),
      ],
    });
  });

  it('使用 PowerShell AST 标记冒号绑定变量参数为动态证据', async () => {
    const analysis = await analyzeShellCommand('Get-Content -Path:$env:TARGET', 'powershell');
    const evidence = analysis.subcommands[0]?.evidence;

    expect(analysis).toMatchObject({ sideEffect: 'unknown', permission: 'ask' });
    expect(evidence?.validation.status).toBe('partial');
    expect(evidence?.arguments).toContainEqual(expect.objectContaining({
      astType: 'CommandParameterAst',
      dynamic: true,
      role: 'dynamic',
    }));
    expect(evidence?.resourceOperands).toContainEqual(expect.objectContaining({
      parameterName: '-path',
      rawValue: '$env:TARGET',
      dynamic: true,
    }));
    expect(evidence?.possibleEffects).toEqual(expect.arrayContaining(['filesystemRead', 'unknown']));
  });

  it('区分 find 的普通枚举与嵌套命令执行 action', async () => {
    const safe = await analyzeShellCommand('find . -type f', 'posix');
    const executing = await analyzeShellCommand('find . -exec rm {} +', 'posix');

    expect(safe).toMatchObject({ sideEffect: 'read', permission: 'allow' });
    expect(safe.subcommands[0]?.evidence.validation.status).toBe('validated');
    expect(executing).toMatchObject({ sideEffect: 'unknown', permission: 'ask' });
    expect(executing.subcommands[0]?.evidence).toMatchObject({
      validation: { status: 'rejected' },
    });
    expect(executing.subcommands[0]?.evidence.possibleEffects).toEqual(expect.arrayContaining([
      'filesystemRead',
      'processStart',
      'codeExecution',
    ]));
  });

  it('区分 git 只读子命令与输出文件参数', async () => {
    const readonly = await analyzeShellCommand('git log --oneline', 'posix');
    const writing = await analyzeShellCommand('git log --output=result.txt', 'posix');

    expect(readonly).toMatchObject({ sideEffect: 'read', permission: 'allow' });
    expect(readonly.subcommands[0]?.evidence.validation).toMatchObject({
      status: 'validated',
      matchedSubcommand: 'log',
    });
    expect(writing).toMatchObject({ sideEffect: 'write', permission: 'ask' });
    expect(writing.subcommands[0]?.evidence.resourceOperands).toContainEqual(expect.objectContaining({
      parameterName: '--output',
      access: 'write',
      rawValue: 'result.txt',
    }));
  });

  it('区分 PowerShell 外部程序与同名脚本', async () => {
    const git = await analyzeShellCommand('git status', 'powershell');
    const script = await analyzeShellCommand('.\\scripts\\Get-Content.ps1 package.json', 'powershell');

    expect(git).toMatchObject({ sideEffect: 'read', permission: 'allow' });
    expect(git.subcommands[0]?.evidence).toMatchObject({
      identity: { canonicalName: 'git', kind: 'application' },
      validation: { status: 'validated', matchedSubcommand: 'status' },
    });
    expect(script).toMatchObject({ sideEffect: 'unknown', permission: 'ask' });
    expect(script.subcommands[0]?.evidence).toMatchObject({
      identity: { kind: 'script' },
      validation: { status: 'validated' },
      possibleEffects: ['processStart', 'codeExecution'],
    });
  });

  it.each(['npm test', 'vitest'])('不把项目代码执行命令伪装成只读：%s', async command => {
    const analysis = await analyzeShellCommand(command, 'posix');

    expect(analysis).toMatchObject({ sideEffect: 'unknown', permission: 'ask' });
    expect(analysis.subcommands[0]?.evidence).toMatchObject({
      validation: { status: 'validated' },
      possibleEffects: ['processStart', 'codeExecution'],
    });
  });

  it('同时表达 Invoke-WebRequest 的网络访问和输出文件写入', async () => {
    const analysis = await analyzeShellCommand(
      'Invoke-WebRequest -Uri https://example.com -OutFile result.html',
      'powershell',
    );
    const evidence = analysis.subcommands[0]?.evidence;

    expect(analysis).toMatchObject({ sideEffect: 'write', permission: 'ask' });
    expect(evidence?.possibleEffects).toEqual(expect.arrayContaining(['network', 'filesystemWrite']));
    expect(evidence?.resourceOperands).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'network', access: 'connect', rawValue: 'https://example.com' }),
      expect.objectContaining({ kind: 'filesystem', access: 'write', rawValue: 'result.html' }),
    ]));
  });

  it('规范 PowerShell 通用参数的 Unicode 横线与绑定值', () => {
    expect(normalizePowerShellParameterName('–ErrorAction:SilentlyContinue')).toBe('-erroraction');
    expect(normalizePowerShellParameterName('-WarningVariable=result')).toBe('-warningvariable');
  });

  it('识别模块限定 cmdlet，并拒绝同名脚本伪装', async () => {
    const cmdlet = await parseFirstPowerShellCommand(
      'Microsoft.PowerShell.Management\\Get-ChildItem -Path .',
    );
    const script = await parseFirstPowerShellCommand('.\\Get-ChildItem.ps1 -Path .');

    expect(resolvePowerShellCommandIdentity(cmdlet)).toMatchObject({
      canonicalName: 'get-childitem',
      kind: 'cmdlet',
      stable: true,
    });
    expect(validatePowerShellReadOnlyCommand(cmdlet).behavior).toBe('allow');
    expect(validatePowerShellReadOnlyCommand(script)).toMatchObject({
      behavior: 'ask',
      code: 'powershell.executable-content',
    });
  });

  it('接受通用参数并保守处理动态参数与未知参数', async () => {
    const common = await parseFirstPowerShellCommand(
      'Get-ChildItem -Path . -ErrorAction SilentlyContinue',
    );
    const dynamic = await parseFirstPowerShellCommand('Get-Content -Path:$env:TARGET');
    const unknown = await parseFirstPowerShellCommand('Get-ChildItem -Unverified value');

    expect(validatePowerShellReadOnlyCommand(common).behavior).toBe('allow');
    expect(validatePowerShellReadOnlyCommand(dynamic)).toMatchObject({
      behavior: 'ask',
      code: 'powershell.dynamic-argument',
    });
    expect(validatePowerShellReadOnlyCommand(unknown)).toMatchObject({
      behavior: 'ask',
      code: 'powershell.parameter-unrecognized',
    });
  });

  it.each([
    ['git log --oneline', 'allow'],
    ['git commit -m message', 'ask'],
    ['gh pr view 1', 'allow'],
    ['gh pr create', 'ask'],
    ['docker ps', 'allow'],
    ['docker run image', 'ask'],
    ['dotnet --info', 'allow'],
    ['dotnet build', 'ask'],
  ] as const)('按外部程序子命令验证只读语义：%s', async (command, expected) => {
    const parsed = await parseFirstPowerShellCommand(command);

    expect(validatePowerShellReadOnlyCommand(parsed).behavior).toBe(expected);
  });
});
