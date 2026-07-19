/**
 * Shell 命令分析契约测试。
 * 覆盖复合语法、PowerShell AST 权威分析、保守拒绝和 hardline 不可降级规则。
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

  it('分析能力不足时应说明风险事实，不应声称 Shell 不支持该语法', async () => {
    const analysis = await analyzeShellCommand('cat a.txt | grep x', 'posix', disabledFeatures);
    const reasons = analysis.riskSignals.map(signal => signal.reason);

    expect(reasons).toContain('命令包含管道，跨命令数据流需要额外确认');
    expect(reasons.join('\n')).not.toContain('当前阶段不支持');
    expect(reasons.join('\n')).not.toContain('当前 Shell 暂不支持');
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

  it('PowerShell cmdlet 别名应投影为规范命令身份', async () => {
    const analysis = await analyzeShellCommand('gci C:\\ -Force', 'powershell');

    expect(analysis.subcommands).toHaveLength(1);
    expect(analysis.subcommands[0]).toMatchObject({
      executable: 'get-childitem',
    });
  });

  it('动态参数应保留在 PowerShell AST 安全标志中', async () => {
    const analysis = await analyzeShellCommand('Write-Host "$value"', 'powershell');

    expect(analysis.subcommands).toHaveLength(1);
    expect(analysis.powershellSecurity?.hasDynamicArguments).toBe(true);
  });

  it('外部 CLI 应保留命令身份和已有子命令参数', async () => {
    const analysis = await analyzeShellCommand('docker ps', 'powershell');

    expect(analysis.subcommands[0]).toMatchObject({
      executable: 'docker',
      arguments: ['ps'],
    });
  });

  it('使用原生 AST 分析计算属性，不把哈希表内分号切成顶层命令', async () => {
    const command = `Write-Host "=== C: Disk Info ==="; Get-PSDrive C | Select-Object Name, Used, Free, @{N='TotalGB';E={[math]::Round(($_.Used+$_.Free)/1GB,2)}}, @{N='UsedGB';E={[math]::Round($_.Used/1GB,2)}}, @{N='FreeGB';E={[math]::Round($_.Free/1GB,2)}}, @{N='FreePct';E={[math]::Round($_.Free/($_.Used+$_.Free)*100,1)}}`;

    const analysis = await analyzeShellCommand(command, 'powershell');

    expect(analysis).toMatchObject({
      parseStatus: 'parsed',
      commandShape: 'nested',
      sideEffect: 'read',
      permission: 'allow',
    });
    expect(analysis.subcommands.map(segment => segment.executable)).toEqual([
      'write-host',
      'get-psdrive',
      'select-object',
    ]);
    expect(analysis.riskSignals).toEqual([]);
    expect(analysis.executionEffects?.possibleEffects).toEqual(expect.arrayContaining([
      'systemRead',
      'pureTransform',
    ]));
  });

  it('允许没有动态表达式的等价 PowerShell 展示管道', async () => {
    const command = 'Write-Host "=== C: Disk Info ==="; Get-PSDrive C | Select-Object Name, Used, Free';

    const analysis = await analyzeShellCommand(command, 'powershell');

    expect(analysis).toMatchObject({
      parseStatus: 'parsed',
      commandShape: 'compound',
      sideEffect: 'read',
      permission: 'allow',
    });
    expect(analysis.subcommands.map(segment => segment.executable)).toEqual([
      'write-host',
      'get-psdrive',
      'select-object',
    ]);
  });

  it('递归动态路径的磁盘调查命令仅产生一条动态结构风险', async () => {
    const command = `Write-Host "=== C: Root Top-Level Folders (Size in GB) ==="; Get-ChildItem -Path C:\\ -Directory -ErrorAction SilentlyContinue | ForEach-Object { $folder = $_; $size = (Get-ChildItem -Path $folder.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum; if ($size -gt 0) { [PSCustomObject]@{ Folder = $folder.Name; SizeGB = [math]::Round($size/1GB, 2); ItemCount = (Get-ChildItem -Path $folder.FullName -Recurse -ErrorAction SilentlyContinue | Measure-Object).Count } }} | Sort-Object SizeGB -Descending | Select-Object -First 20`;
    const analysis = await analyzeShellCommand(command, 'powershell');

    expect(analysis).toMatchObject({ parseStatus: 'parsed', permission: 'ask' });
    expect(analysis.riskSignals).toEqual([
      expect.objectContaining({ code: 'powershell.dynamic-structure' }),
    ]);
    expect(analysis.subcommands.length).toBeLessThan(10);
  });

  it('允许可静态证明的磁盘枚举、计算属性和格式化管道', async () => {
    const command = `Write-Host "=== C: Large Files at Root ==="; Get-ChildItem -Path C:\\ -File -ErrorAction SilentlyContinue | Sort-Object Length -Descending | Select-Object Name, @{N='SizeMB';E={[math]::Round($_.Length/1MB,2)}} | Format-Table -AutoSize`;
    const analysis = await analyzeShellCommand(command, 'powershell');

    expect(analysis).toMatchObject({
      parseStatus: 'parsed',
      sideEffect: 'read',
      permission: 'allow',
    });
    expect(analysis.riskSignals).toEqual([]);
    expect(analysis.executionEffects?.possibleEffects).toEqual(expect.arrayContaining([
      'filesystemRead',
      'pureTransform',
    ]));
  });

  it('将 ForEach-Object 成员调用保守归为单次 ask', async () => {
    const analysis = await analyzeShellCommand(
      'Get-ChildItem C:\\ | ForEach-Object { $_.Delete() }',
      'powershell',
    );

    expect(analysis).toMatchObject({ parseStatus: 'parsed', sideEffect: 'unknown', permission: 'ask' });
    expect(analysis.riskSignals).toEqual([
      expect.objectContaining({ code: 'powershell.dynamic-structure' }),
    ]);
    expect(analysis.riskReason).toContain('成员调用');
  });

  it.each([
    ['Write-Output --% Remove-Item C:\\temp.txt', '停止解析标记'],
    ['while ($true) { Get-Process }', '控制流'],
  ])('动态 PowerShell 结构保守 ask: %s', async (command, expectedReason) => {
    const analysis = await analyzeShellCommand(command, 'powershell');

    expect(analysis).toMatchObject({ parseStatus: 'parsed', permission: 'ask' });
    expect(analysis.riskSignals).toEqual([
      expect.objectContaining({ code: 'powershell.dynamic-structure' }),
    ]);
    expect(analysis.riskReason).toContain(expectedReason);
  });

  it('允许可静态证明的字面量表达式进入只读管道', async () => {
    const analysis = await analyzeShellCommand("'diagnostic' | Write-Output", 'powershell');

    expect(analysis).toMatchObject({
      parseStatus: 'parsed',
      sideEffect: 'read',
      permission: 'allow',
    });
    expect(analysis.riskSignals).toEqual([]);
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

  it('条件链中的普通写操作按整体最高风险进入 ask', async () => {
    const gitWriteBranch = await analyzeShellCommand('cat a.txt; git commit -m message', 'posix');
    const askBranch = await analyzeShellCommand('cat a.txt; rm output.txt', 'posix');

    expect(gitWriteBranch).toMatchObject({ sideEffect: 'unknown', permission: 'ask' });
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
    await expect(analyzeShellCommand('grep "unfinished', 'posix')).resolves.toMatchObject({
      parseStatus: 'invalid',
      sideEffect: 'unknown',
      permission: 'ask',
    });
  });

  it('超过 50 个子命令时停止完整分析并保守询问', async () => {
    const command = Array.from({ length: 51 }, () => 'pwd').join(';');
    const analysis = await analyzeShellCommand(command, 'posix');

    expect(analysis).toMatchObject({ parseStatus: 'unsupported', permission: 'ask' });
    expect(analysis.riskSignals.some(signal => signal.code === 'structure.too-many-subcommands')).toBe(true);
  });

  it('成功解析记录根删除写入事实，降级扫描保留 hardline 且不误判字面量', async () => {
    const supported = await analyzeShellCommand('echo safe; rm -rf /', 'posix');
    const unsupported = await analyzeShellCommand('echo safe | rm -rf /', 'posix', disabledFeatures);
    const quotedLiteral = await analyzeShellCommand('echo "rm -rf /"', 'posix');

    expect(supported).toMatchObject({ sideEffect: 'write', permission: 'ask' });
    expect(unsupported).toMatchObject({ parseStatus: 'unsupported', sideEffect: 'hardline' });
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

  it('保留复杂 PowerShell 的 statement、变量、类型和嵌套命令归属', async () => {
    const parser = new PowerShellAstParser();
    const result = await parser.parse(
      `Get-ChildItem C:\\ | ForEach-Object { $size = (Get-ChildItem $_ -File | Measure-Object Length -Sum).Sum; if ($size -gt 0) { [PSCustomObject]@{ SizeGB = [math]::Round($size/1GB, 2) } } } | Sort-Object SizeGB`,
    );

    expect(result.parseStatus).toBe('parsed');
    expect(result.powershellProgram).toBeDefined();
    expect(result.powershellProgram?.statements.map(statement => statement.statementType)).toEqual(
      expect.arrayContaining(['PipelineAst', 'AssignmentStatementAst', 'IfStatementAst']),
    );
    expect(result.powershellProgram?.variables.map(variable => variable.path)).toEqual(
      expect.arrayContaining(['size', '_']),
    );
    expect(result.powershellProgram?.typeLiterals.map(type => type.toLowerCase())).toEqual(
      expect.arrayContaining(['pscustomobject', 'math']),
    );
    expect(result.powershellProgram?.statements.some(statement => (
      statement.nestedCommands.some(command => command.name === 'Get-ChildItem')
    ))).toBe(true);
    expect(new Set(result.nodes.map(node => `${node.statementIndex}:${node.command}`)).size).toBe(result.nodes.length);
  });

  it('区分 PowerShell 命令名的裸词、字符串和动态表达式', async () => {
    const parser = new PowerShellAstParser();
    const bareword = await parser.parse('Get-Process');
    const string = await parser.parse("& 'Get-Process'");
    const expression = await parser.parse('& $commandName');

    expect(bareword.powershellProgram?.statements[0]?.commands[0]?.nameType).toBe('bareword');
    expect(string.powershellProgram?.statements[0]?.commands[0]?.nameType).toBe('string');
    expect(expression.powershellProgram?.statements[0]?.commands[0]?.nameType).toBe('expression');
  });

  it('保留 PowerShell 冒号绑定参数的直接表达式子节点', async () => {
    const parser = new PowerShellAstParser();
    const result = await parser.parse('Write-Output -InputObject:$env:PATH');
    const command = result.powershellProgram?.statements
      .flatMap(statement => statement.commands)
      .find(item => item.name === 'Write-Output');
    const parameter = command?.elements.find(element => element.astType === 'CommandParameterAst');

    expect(parameter).toMatchObject({ text: '-InputObject:$env:PATH' });
    expect(parameter?.children).toEqual([
      expect.objectContaining({ astType: 'VariableExpressionAst', text: '$env:PATH' }),
    ]);
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

  it('PowerShell 解析失败时保守询问而不是直接拒绝', async () => {
    await expect(analyzeShellCommand('Write-Output $(', 'powershell')).resolves.toMatchObject({
      parseStatus: 'invalid',
      permission: 'ask',
    });
  });
});
