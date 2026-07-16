/**
 * PowerShell 有限表达式语义测试。
 * 验证逐 statement 的 effect、变量流、资源表达式、终止性及其权限投影。
 */

import { describe, expect, it } from 'vitest';
import { analyzeShellCommand } from '../../../src/adapters/tools/impl/system/command-analysis/index.js';

describe('PowerShell 表达式语义', () => {
  it('将普通变量赋值识别为当前调用内的局部绑定', async () => {
    const analysis = await analyzeShellCommand('$size = 10', 'powershell');
    const summary = analysis.powershellProgram?.expressionEffects?.[0];

    expect(analysis).toMatchObject({ sideEffect: 'read', permission: 'allow' });
    expect(summary).toMatchObject({
      effects: ['localMutation'],
      writesVariables: ['size'],
      termination: 'bounded',
      confidence: 'proven',
    });
  });

  it('区分环境变量赋值与普通局部赋值', async () => {
    const analysis = await analyzeShellCommand("$env:PATH = 'C:\\tools'", 'powershell');
    const summary = analysis.powershellProgram?.expressionEffects?.[0];

    expect(summary).toMatchObject({
      effects: ['sessionMutation'],
      writesVariables: ['env:PATH'],
      confidence: 'proven',
    });
    expect(analysis).toMatchObject({ sideEffect: 'unknown', permission: 'ask' });
  });

  it('将 System.Math 静态方法识别为纯数值计算', async () => {
    const analysis = await analyzeShellCommand('[math]::Round($size / 1GB, 2)', 'powershell');
    const summary = analysis.powershellProgram?.expressionEffects?.find(item => (
      item.effects.includes('pureTransform')
    ));

    expect(summary).toMatchObject({
      effects: ['pureTransform'],
      readsVariables: ['size'],
      termination: 'bounded',
      confidence: 'proven',
    });
    expect(analysis).toMatchObject({ sideEffect: 'read', permission: 'allow' });
  });

  it('识别 System.IO.File 的明确文件写入方法', async () => {
    const analysis = await analyzeShellCommand("[System.IO.File]::Delete('C:\\data.txt')", 'powershell');
    const summary = analysis.powershellProgram?.expressionEffects?.find(item => (
      item.effects.includes('filesystemWrite')
    ));

    expect(summary).toMatchObject({
      effects: ['filesystemWrite'],
      confidence: 'proven',
    });
    expect(summary?.resourceExpressions).toContain("[System.IO.File]::Delete('C:\\data.txt')");
    expect(analysis).toMatchObject({ sideEffect: 'write', permission: 'ask' });
  });

  it('未知实例方法和对象 setter 保留 unknown', async () => {
    const invocation = await analyzeShellCommand('$_.Delete()', 'powershell');
    const assignment = await analyzeShellCommand("$object.Name = 'changed'", 'powershell');
    const invocationSummary = invocation.powershellProgram?.expressionEffects?.find(item => (
      item.effects.includes('unknown')
    ));
    const assignmentSummary = assignment.powershellProgram?.expressionEffects?.find(item => (
      item.effects.includes('unknown')
    ));

    expect(invocationSummary).toMatchObject({ confidence: 'unknown' });
    expect(invocationSummary?.reason).toContain('未登记成员调用');
    expect(assignmentSummary).toMatchObject({ confidence: 'unknown' });
    expect(assignmentSummary?.reason).toContain('setter');
  });

  it('将循环标记为可能不终止', async () => {
    const analysis = await analyzeShellCommand('while ($true) { Get-Process }', 'powershell');
    const summary = analysis.powershellProgram?.expressionEffects?.find(item => (
      item.termination === 'potentially-unbounded'
    ));

    expect(summary).toMatchObject({
      effects: ['unknown'],
      termination: 'potentially-unbounded',
      confidence: 'unknown',
    });
  });

  it('保留脚本块内部的局部绑定和纯数学调用', async () => {
    const analysis = await analyzeShellCommand(
      'Get-ChildItem C:\\ | ForEach-Object { $size = $_.Length; [math]::Round($size / 1KB, 2) }',
      'powershell',
    );
    const summaries = analysis.powershellProgram?.expressionEffects ?? [];

    expect(analysis).toMatchObject({ commandShape: 'nested', sideEffect: 'read', permission: 'allow' });
    expect(summaries).toContainEqual(expect.objectContaining({
      effects: ['localMutation'],
      writesVariables: ['size'],
      confidence: 'conditional',
    }));
    expect(summaries).toContainEqual(expect.objectContaining({
      effects: ['pureTransform'],
      readsVariables: ['size'],
      confidence: 'proven',
    }));
  });
});
