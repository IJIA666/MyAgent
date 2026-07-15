/**
 * Shell 命令分析契约测试。
 * 覆盖阶段 3 的有限复合语法、保守拒绝和 hardline 不可降级规则。
 */

import { describe, expect, it } from 'vitest';
import { analyzeShellCommand } from '../../../src/adapters/tools/impl/system/command-analysis/index.js';
import { PowerShellAstParser } from '../../../src/adapters/tools/impl/system/command-analysis/powershell-ast-parser.js';

describe('Shell 命令分析', () => {
  const disabledFeatures = {
    pipelines: false,
    conditionals: false,
    redirections: false,
    background: false,
    nested: false,
  } as const;

  const pipelineFeatures = {
    pipelines: true,
    conditionals: false,
    redirections: false,
    background: false,
    nested: false,
  } as const;

  it('正常默认启用已验收能力，显式全关时保守回退', async () => {
    const command = 'cat a.txt | grep x';

    await expect(analyzeShellCommand(command, 'posix'))
      .resolves.toMatchObject({ parseStatus: 'parsed', sideEffect: 'read', permission: 'allow' });
    await expect(analyzeShellCommand(command, 'posix', disabledFeatures))
      .resolves.toMatchObject({ parseStatus: 'unsupported', permission: 'deny' });
  });

  it('提取 POSIX 单级、多级和标准错误管道并保留顺序', async () => {
    const analysis = await analyzeShellCommand('cat a.txt | grep x b.txt |& cat', 'posix', pipelineFeatures);

    expect(analysis).toMatchObject({ parseStatus: 'parsed', commandShape: 'compound', sideEffect: 'read', permission: 'allow' });
    expect(analysis.subcommands.map(segment => segment.connectorBefore)).toEqual([undefined, '|', '|&']);
    expect(analysis.subcommands.map(segment => segment.pipelineIndex)).toEqual([0, 1, 2]);
  });

  it('分析 PowerShell 读取管道并聚合每个原子命令', async () => {
    const analysis = await analyzeShellCommand('Get-Content a.txt | Select-String x', 'powershell', pipelineFeatures);

    expect(analysis).toMatchObject({ parseStatus: 'parsed', commandShape: 'compound', sideEffect: 'read', permission: 'allow' });
    expect(analysis.subcommands.map(segment => segment.executable)).toEqual(['get-content', 'select-string']);
    expect(analysis.subcommands.map(segment => segment.pipelineIndex)).toEqual([0, 1]);
  });

  it('管道按最高风险聚合，且不拆分引号内管道文本', async () => {
    const mixed = await analyzeShellCommand('cat a.txt | rm output.txt', 'posix', pipelineFeatures);
    const quoted = await analyzeShellCommand('echo "a|b"', 'posix', pipelineFeatures);

    expect(mixed).toMatchObject({ parseStatus: 'parsed', sideEffect: 'write', permission: 'ask' });
    expect(quoted).toMatchObject({ parseStatus: 'parsed', commandShape: 'atomic', sideEffect: 'read', permission: 'allow' });
    expect(quoted.subcommands).toHaveLength(1);
  });

  it('将重定向副作用合入同一权限证据，抑制只根据命令名自动 allow', async () => {
    const redirectFeatures = {
      pipelines: false,
      conditionals: false,
      redirections: true,
      background: false,
      nested: false,
    } as const;

    // 写重定向使只读命令升级为 write/ask
    const writeRedirect = await analyzeShellCommand('cat a.txt > output.txt', 'posix', redirectFeatures);
    expect(writeRedirect).toMatchObject({ parseStatus: 'parsed', sideEffect: 'write', permission: 'ask' });

    // 追加写入同样升级
    const appendRedirect = await analyzeShellCommand('echo log >> /etc/config', 'posix', redirectFeatures);
    expect(appendRedirect).toMatchObject({ parseStatus: 'parsed', sideEffect: 'write', permission: 'ask' });

    // 输入重定向检测为敏感读（目标文件可能涉及敏感信息）
    const readRedirect = await analyzeShellCommand('wc -l < input.txt', 'posix', redirectFeatures);
    expect(readRedirect).toMatchObject({ parseStatus: 'parsed', sideEffect: 'sensitive-read', permission: 'ask' });
  });

  it('重定向开关关闭时回退到旧行为', async () => {
    const disabled = {
      pipelines: false, conditionals: false, redirections: false,
      background: false, nested: false,
    } as const;
    const result = await analyzeShellCommand('cat a.txt > output.txt', 'posix', disabled);
    expect(result.parseStatus).toBe('unsupported');
  });

  it('管道首命令只读但带写重定向时不会自动 allow', async () => {
    const features = {
      pipelines: true, conditionals: false, redirections: true,
      background: false, nested: false,
    } as const;
    // cat 是只读命令，但 > 写重定向使整体升级为 write/ask
    const pipeWithRedirect = await analyzeShellCommand('cat a.txt > output.txt', 'posix', features);
    expect(pipeWithRedirect).toMatchObject({ parseStatus: 'parsed', sideEffect: 'write', permission: 'ask' });
    // 管道中写重定向同样正确聚合
    const multiCmd = await analyzeShellCommand('echo hello | tee output.txt > result.log', 'posix', features);
    expect(multiCmd).toMatchObject({ parseStatus: 'parsed', sideEffect: 'write', permission: 'ask' });
  });

  it('按已决议 Shell 分析原子命令', async () => {
    const posix = await analyzeShellCommand('cat package.json', 'posix');
    const powershell = await analyzeShellCommand('Get-Content package.json', 'powershell');
    const cmd = await analyzeShellCommand('type package.json', 'cmd');

    expect(posix).toMatchObject({ parseStatus: 'parsed', commandShape: 'atomic', sideEffect: 'read', permission: 'allow' });
    expect(powershell).toMatchObject({ parseStatus: 'parsed', commandShape: 'atomic', sideEffect: 'read', permission: 'allow' });
    expect(cmd).toMatchObject({ parseStatus: 'parsed', commandShape: 'atomic', sideEffect: 'read', permission: 'allow' });
  });

  it('支持 Bash 顶层分号、逻辑与和逻辑或并保留连接关系', async () => {
    const analysis = await analyzeShellCommand('cat a.txt; grep x b.txt && ls || pwd', 'posix');

    expect(analysis).toMatchObject({ parseStatus: 'parsed', commandShape: 'compound', sideEffect: 'read', permission: 'allow' });
    expect(analysis.subcommands.map(segment => segment.connectorBefore)).toEqual([undefined, ';', '&&', '||']);
  });

  it('条件链中 hardline 分支导致整体 deny、ask 分支导致整体 ask', async () => {
    const hardlineBranch = await analyzeShellCommand('cat a.txt; git commit -m blocked', 'posix');
    const askBranch = await analyzeShellCommand('cat a.txt; rm output.txt', 'posix');

    expect(hardlineBranch).toMatchObject({ sideEffect: 'hardline', permission: 'deny' });
    expect(askBranch).toMatchObject({ sideEffect: 'write', permission: 'ask' });
  });

  it('PowerShell 条件链开关开启后支持 && 和 ||', async () => {
    const condFeatures = {
      pipelines: false,
      conditionals: true,
      redirections: false,
      background: false,
      nested: false,
    } as const;
    const psConditional = await analyzeShellCommand('Get-ChildItem && Write-Output done', 'powershell', condFeatures);
    const psOr = await analyzeShellCommand('Write-Output fail || Get-ChildItem', 'powershell', condFeatures);

    expect(psConditional).toMatchObject({ parseStatus: 'parsed', commandShape: 'compound' });
    expect(psOr).toMatchObject({ parseStatus: 'parsed', commandShape: 'compound' });
    expect(psConditional.subcommands.map(s => s.connectorBefore)).toEqual([undefined, '&&']);
    expect(psOr.subcommands.map(s => s.connectorBefore)).toEqual([undefined, '||']);
  });

  it('条件链开关关闭时 && || 在 PowerShell 中回退为 unsupported', async () => {
    const disabledFeatures = {
      pipelines: false,
      conditionals: false,
      redirections: false,
      background: false,
      nested: false,
    } as const;
    const psAnd = await analyzeShellCommand('Write-Output a && Write-Output b', 'powershell', disabledFeatures);
    expect(psAnd.parseStatus).toBe('unsupported');
  });

  it('PowerShell 默认支持条件链，Cmd 仍不开放复合语法', async () => {
    const powershell = await analyzeShellCommand('Get-ChildItem; Get-Process', 'powershell');
    const powershellAnd = await analyzeShellCommand('Get-ChildItem && Get-Process', 'powershell');
    const cmd = await analyzeShellCommand('dir & echo done', 'cmd');

    expect(powershell).toMatchObject({ parseStatus: 'parsed', commandShape: 'compound', permission: 'allow' });
    expect(powershellAnd).toMatchObject({ parseStatus: 'parsed', permission: 'allow' });
    expect(cmd).toMatchObject({ parseStatus: 'unsupported', permission: 'deny' });
  });

  it('POSIX 后台 & 在 background 开关开启时被识别', async () => {
    const bgFeatures = {
      pipelines: false, conditionals: false, redirections: false,
      background: true, nested: false,
    } as const;
    const bg = await analyzeShellCommand('sleep 5 & echo done', 'posix', bgFeatures);
    expect(bg).toMatchObject({ parseStatus: 'parsed', commandShape: 'compound' });
    expect(bg.subcommands.map(s => s.connectorBefore)).toEqual([undefined, '&']);
    expect(bg.subcommands.map(s => s.background)).toEqual([undefined, true]);
  });

  it('POSIX 后台 & 开关关闭时回退为 unsupported', async () => {
    const disabledFeatures = {
      pipelines: false, conditionals: false, redirections: false,
      background: false, nested: false,
    } as const;
    const bg = await analyzeShellCommand('sleep 5 & echo done', 'posix', disabledFeatures);
    expect(bg.parseStatus).toBe('unsupported');
  });

  it('POSIX 命令替换 $() 在 nested 开关关闭时回退为 unsupported', async () => {
    const disabledFeatures = {
      pipelines: false, conditionals: false, redirections: false,
      background: false, nested: false,
    } as const;
    const sub = await analyzeShellCommand('echo $(date)', 'posix', disabledFeatures);
    expect(sub.parseStatus).toBe('unsupported');
  });

  it('POSIX 子 Shell () 在 nested 开关关闭时回退为 unsupported', async () => {
    const disabledFeatures = {
      pipelines: false, conditionals: false, redirections: false,
      background: false, nested: false,
    } as const;
    const sub = await analyzeShellCommand('(cd /tmp && pwd)', 'posix', disabledFeatures);
    expect(sub.parseStatus).toBe('unsupported');
  });

  it('将引号内操作符视为普通字面量', async () => {
    const posix = await analyzeShellCommand('git log --grep="feat;fix"', 'posix');
    const powershell = await analyzeShellCommand('Write-Output "a;b"', 'powershell');

    expect(posix).toMatchObject({ parseStatus: 'parsed', commandShape: 'atomic', permission: 'allow' });
    expect(powershell).toMatchObject({ parseStatus: 'parsed', commandShape: 'atomic', permission: 'allow' });
  });

  it.each([
    ['cat a.txt | grep x', 'posix'],
    ['cat a.txt > b.txt', 'posix'],
    ['Get-Content a.txt | Select-String x', 'powershell'],
    ['Write-Output $(Get-Process)', 'powershell'],
    ['echo one\necho two', 'posix'],
  ] as const)('拒绝未支持复杂结构: %s', async (command, shellKind) => {
    await expect(analyzeShellCommand(command, shellKind, disabledFeatures)).resolves.toMatchObject({ parseStatus: 'unsupported', permission: 'deny' });
  });

  it('将不平衡引号标记为 invalid', async () => {
    await expect(analyzeShellCommand('grep "unfinished', 'posix')).resolves.toMatchObject({ parseStatus: 'invalid', permission: 'deny' });
  });

  it('拒绝超过 50 个子命令的输入', async () => {
    const command = Array.from({ length: 51 }, () => 'pwd').join(';');
    const analysis = await analyzeShellCommand(command, 'posix');

    expect(analysis).toMatchObject({ parseStatus: 'unsupported', permission: 'deny' });
    expect(analysis.riskSignals.some(signal => signal.code === 'structure.too-many-subcommands')).toBe(true);
  });

  it('hardline 在支持和未支持结构中都保持 deny', async () => {
    const supported = await analyzeShellCommand('echo safe; git commit -m blocked', 'posix');
    const unsupported = await analyzeShellCommand('echo safe | git commit -m blocked', 'posix', disabledFeatures);
    const quotedLiteral = await analyzeShellCommand('echo "git commit -m literal"', 'posix');

    expect(supported).toMatchObject({ sideEffect: 'hardline', permission: 'deny' });
    expect(unsupported).toMatchObject({ parseStatus: 'unsupported', sideEffect: 'hardline', permission: 'deny' });
    expect(quotedLiteral).toMatchObject({ sideEffect: 'read', permission: 'allow' });
  });

  it('缓存相同 PowerShell 命令并生成稳定嵌套路径', async () => {
    let calls = 0;
    const parser = new PowerShellAstParser({
      runner: async () => {
        calls += 1;
        return JSON.stringify({
          errors: [],
          nodes: [
            { text: 'Write-Output $(Get-Process)', start: 0, end: 27, parentStart: null, redirections: [] },
            { text: 'Get-Process', start: 15, end: 26, parentStart: 0, redirections: [] },
          ],
        });
      },
    });

    const first = await parser.parse('Write-Output $(Get-Process)');
    const second = await parser.parse('Write-Output $(Get-Process)');

    expect(calls).toBe(1);
    expect(second).toBe(first);
    expect(first.nodes.map(node => node.nodePath)).toEqual([[0], [0, 0]]);
  });

  it('将 PowerShell 解析超时和输出越界转换为 unsupported', async () => {
    const timeoutParser = new PowerShellAstParser({
      timeoutMs: 5,
      runner: async () => await new Promise<string>(() => undefined),
    });
    const outputParser = new PowerShellAstParser({
      maxOutputBytes: 8,
      runner: async () => '{"nodes":[]}',
    });

    const timeout = await timeoutParser.parse('Get-Process');
    const outputLimit = await outputParser.parse('Get-Process');

    expect(timeout.riskSignals).toContainEqual(expect.objectContaining({ code: 'parser.powershell-timeout' }));
    expect(outputLimit.riskSignals).toContainEqual(expect.objectContaining({ code: 'parser.powershell-output-limit' }));
  });

  it('将 PowerShell 语法错误标记为 invalid', async () => {
    const parser = new PowerShellAstParser({
      runner: async () => JSON.stringify({ errors: ['缺少右括号'], nodes: [] }),
    });

    const result = await parser.parse('Write-Output $(');

    expect(result).toMatchObject({ parseStatus: 'invalid', nodes: [] });
    expect(result.riskSignals).toContainEqual(expect.objectContaining({ code: 'parser.powershell-invalid' }));
  });
});
