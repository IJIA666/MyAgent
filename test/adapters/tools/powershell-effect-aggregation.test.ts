/**
 * PowerShell 嵌套执行效果聚合测试。
 * 验证 child statement 的行为会进入父级摘要，并区分确定行为、可能行为与未解析风险。
 */

import { describe, expect, it } from 'vitest';
import { analyzeShellCommand } from '../../../src/adapters/tools/impl/system/command-analysis/index.js';

describe('PowerShell 嵌套执行效果聚合', () => {
  it('允许仅含属性读取的高阶脚本块', async () => {
    const analysis = await analyzeShellCommand(
      'Get-ChildItem C:\\ | ForEach-Object { $_.Length }',
      'powershell',
    );

    expect(analysis).toMatchObject({
      parseStatus: 'parsed',
      commandShape: 'nested',
      sideEffect: 'read',
      permission: 'allow',
    });
    expect(analysis.executionEffects?.possibleEffects).toEqual(expect.arrayContaining([
      'filesystemRead',
      'pureTransform',
    ]));
    expect(analysis.executionEffects?.uncertaintyReasons).toEqual([]);
  });

  it('将高阶脚本块内未登记成员调用聚合为 unknown', async () => {
    const analysis = await analyzeShellCommand(
      'Get-ChildItem C:\\ | ForEach-Object { $_.Delete() }',
      'powershell',
    );

    expect(analysis).toMatchObject({ sideEffect: 'unknown', permission: 'ask' });
    expect(analysis.executionEffects?.possibleEffects).toContain('unknown');
    expect(analysis.executionEffects?.uncertaintyReasons.join('；')).toContain('未登记成员调用');
  });

  it('把条件分支行为记录为 possible effect，而不是无条件 effect', async () => {
    const analysis = await analyzeShellCommand(
      'if ($true) { Get-ChildItem C:\\ } else { Remove-Item C:\\temp.txt }',
      'powershell',
    );

    expect(analysis).toMatchObject({ sideEffect: 'write', permission: 'ask' });
    expect(analysis.executionEffects?.possibleEffects).toEqual(expect.arrayContaining([
      'filesystemRead',
      'filesystemWrite',
    ]));
    expect(analysis.executionEffects?.definiteEffects).not.toContain('filesystemWrite');
  });

  it('条件链首项是 definite，后续项仅是 possible', async () => {
    const analysis = await analyzeShellCommand(
      'Get-ChildItem C:\\temp && Remove-Item C:\\temp.txt',
      'powershell',
    );

    expect(analysis).toMatchObject({ sideEffect: 'write', permission: 'ask' });
    expect(analysis.executionEffects?.definiteEffects).toContain('filesystemRead');
    expect(analysis.executionEffects?.definiteEffects).not.toContain('filesystemWrite');
    expect(analysis.executionEffects?.possibleEffects).toContain('filesystemWrite');
  });

  it('保留环境变量赋值产生的状态迁移', async () => {
    const analysis = await analyzeShellCommand("$env:MYAGENT_TEST = 'enabled'", 'powershell');

    expect(analysis).toMatchObject({ permission: 'ask' });
    expect(analysis.executionEffects?.stateTransitions).toContainEqual(expect.objectContaining({
      kind: 'environment',
    }));
  });

  it('未解析的 splatting 继续保守询问', async () => {
    const analysis = await analyzeShellCommand('Get-ChildItem @options', 'powershell');

    expect(analysis).toMatchObject({ sideEffect: 'unknown', permission: 'ask' });
    expect(analysis.executionEffects?.uncertaintyReasons).toContain('splatting 参数无法静态展开');
  });
});
