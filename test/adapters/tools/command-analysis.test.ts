/**
 * Shell 命令分析契约测试。
 * 覆盖阶段 3 的有限复合语法、保守拒绝和 hardline 不可降级规则。
 */

import { describe, expect, it } from 'vitest';
import { analyzeShellCommand } from '../../../src/adapters/tools/impl/system/command-analysis/index.js';

describe('Shell 命令分析', () => {
  it('按已决议 Shell 分析原子命令', () => {
    const posix = analyzeShellCommand('cat package.json', 'posix');
    const powershell = analyzeShellCommand('Get-Content package.json', 'powershell');
    const cmd = analyzeShellCommand('type package.json', 'cmd');

    expect(posix).toMatchObject({ parseStatus: 'parsed', commandShape: 'atomic', sideEffect: 'read', permission: 'allow' });
    expect(powershell).toMatchObject({ parseStatus: 'parsed', commandShape: 'atomic', sideEffect: 'read', permission: 'allow' });
    expect(cmd).toMatchObject({ parseStatus: 'parsed', commandShape: 'atomic', sideEffect: 'read', permission: 'allow' });
  });

  it('支持 Bash 顶层分号、逻辑与和逻辑或并保留连接关系', () => {
    const analysis = analyzeShellCommand('cat a.txt; grep x b.txt && ls || pwd', 'posix');

    expect(analysis).toMatchObject({ parseStatus: 'parsed', commandShape: 'compound', sideEffect: 'read', permission: 'allow' });
    expect(analysis.subcommands.map(segment => segment.connectorBefore)).toEqual([undefined, ';', '&&', '||']);
  });

  it('PowerShell 仅支持顶层分号，Cmd 不开放复合语法', () => {
    const powershell = analyzeShellCommand('Get-ChildItem; Get-Process', 'powershell');
    const powershellAnd = analyzeShellCommand('Get-ChildItem && Get-Process', 'powershell');
    const cmd = analyzeShellCommand('dir & echo done', 'cmd');

    expect(powershell).toMatchObject({ parseStatus: 'parsed', commandShape: 'compound', permission: 'allow' });
    expect(powershellAnd).toMatchObject({ parseStatus: 'unsupported', permission: 'deny' });
    expect(cmd).toMatchObject({ parseStatus: 'unsupported', permission: 'deny' });
  });

  it('将引号内操作符视为普通字面量', () => {
    const posix = analyzeShellCommand('git log --grep="feat;fix"', 'posix');
    const powershell = analyzeShellCommand('Write-Output "a;b"', 'powershell');

    expect(posix).toMatchObject({ parseStatus: 'parsed', commandShape: 'atomic', permission: 'allow' });
    expect(powershell).toMatchObject({ parseStatus: 'parsed', commandShape: 'atomic', permission: 'allow' });
  });

  it.each([
    ['cat a.txt | grep x', 'posix'],
    ['cat a.txt > b.txt', 'posix'],
    ['Get-Content a.txt | Select-String x', 'powershell'],
    ['Write-Output $(Get-Process)', 'powershell'],
    ['echo one\necho two', 'posix'],
  ] as const)('拒绝未支持复杂结构: %s', (command, shellKind) => {
    expect(analyzeShellCommand(command, shellKind)).toMatchObject({ parseStatus: 'unsupported', permission: 'deny' });
  });

  it('将不平衡引号标记为 invalid', () => {
    expect(analyzeShellCommand('grep "unfinished', 'posix')).toMatchObject({ parseStatus: 'invalid', permission: 'deny' });
  });

  it('拒绝超过 50 个子命令的输入', () => {
    const command = Array.from({ length: 51 }, () => 'pwd').join(';');
    const analysis = analyzeShellCommand(command, 'posix');

    expect(analysis).toMatchObject({ parseStatus: 'unsupported', permission: 'deny' });
    expect(analysis.riskSignals.some(signal => signal.code === 'structure.too-many-subcommands')).toBe(true);
  });

  it('hardline 在支持和未支持结构中都保持 deny', () => {
    const supported = analyzeShellCommand('echo safe; git commit -m blocked', 'posix');
    const unsupported = analyzeShellCommand('echo safe | git commit -m blocked', 'posix');
    const quotedLiteral = analyzeShellCommand('echo "git commit -m literal"', 'posix');

    expect(supported).toMatchObject({ sideEffect: 'hardline', permission: 'deny' });
    expect(unsupported).toMatchObject({ parseStatus: 'unsupported', sideEffect: 'hardline', permission: 'deny' });
    expect(quotedLiteral).toMatchObject({ sideEffect: 'read', permission: 'allow' });
  });
});

