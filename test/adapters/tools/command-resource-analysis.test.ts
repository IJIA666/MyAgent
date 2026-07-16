/**
 * Shell 命令资源与路径分析测试。
 * 验证资源事实、有效 cwd 和确定性分层，不在本层断言最终权限策略。
 */

import { win32 } from 'path';
import { describe, expect, it } from 'vitest';
import { analyzeShellCommand } from '../../../src/adapters/tools/impl/system/command-analysis/index.js';

describe('Shell 命令资源与路径分析', () => {
  const context = {
    cwd: 'D:\\projects\\MyAgent',
    workspaceRoot: 'D:\\projects\\MyAgent',
  } as const;

  it('区分工作区相对文件与系统盘根目录', async () => {
    const workspace = await analyzeShellCommand(
      'Get-Content .\\package.json',
      'powershell',
      undefined,
      context,
    );
    const system = await analyzeShellCommand(
      'Get-ChildItem -Path C:\\ -File',
      'powershell',
      undefined,
      context,
    );

    expect(workspace.resourceAccesses).toContainEqual(expect.objectContaining({
      kind: 'file',
      operation: 'read',
      rawExpression: '.\\package.json',
      resolvedResource: win32.normalize('D:\\projects\\MyAgent\\package.json'),
      scope: 'workspace',
      certainty: 'exact',
    }));
    expect(system.resourceAccesses).toContainEqual(expect.objectContaining({
      kind: 'directory',
      operation: 'read',
      resolvedResource: win32.normalize('C:\\'),
      scope: 'system',
      certainty: 'exact',
    }));
  });

  it('将工作区外删除描述为 external delete', async () => {
    const analysis = await analyzeShellCommand(
      'Remove-Item D:\\outside\\x.txt',
      'powershell',
      undefined,
      context,
    );

    expect(analysis.resourceAccesses).toContainEqual(expect.objectContaining({
      kind: 'file',
      operation: 'delete',
      resolvedResource: win32.normalize('D:\\outside\\x.txt'),
      scope: 'external',
      certainty: 'exact',
    }));
  });

  it('识别 PowerShell 注册表 provider，不误当文件路径', async () => {
    const analysis = await analyzeShellCommand(
      'Get-Item HKLM:\\Software',
      'powershell',
      undefined,
      context,
    );

    expect(analysis.resourceAccesses).toContainEqual(expect.objectContaining({
      kind: 'registry',
      operation: 'read',
      resolvedResource: 'HKLM:\\Software',
      scope: 'system',
      certainty: 'exact',
    }));
  });

  it('同时提取网络请求和输出文件', async () => {
    const analysis = await analyzeShellCommand(
      'Invoke-WebRequest https://example.com -OutFile .\\response.txt',
      'powershell',
      undefined,
      context,
    );

    expect(analysis.resourceAccesses).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'network',
        operation: 'connect',
        resolvedResource: 'https://example.com',
        scope: 'external',
      }),
      expect.objectContaining({
        kind: 'file',
        operation: 'write',
        resolvedResource: win32.normalize('D:\\projects\\MyAgent\\response.txt'),
        scope: 'workspace',
      }),
    ]));
  });

  it('按无条件 Set-Location 更新后续相对路径基准', async () => {
    const analysis = await analyzeShellCommand(
      'Set-Location .\\src; Get-Content .\\index.ts',
      'powershell',
      undefined,
      context,
    );

    expect(analysis.resourceAccesses).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'directory',
        operation: 'mutate',
        resolvedResource: win32.normalize('D:\\projects\\MyAgent\\src'),
      }),
      expect.objectContaining({
        kind: 'file',
        operation: 'read',
        baseContext: win32.normalize('D:\\projects\\MyAgent\\src'),
        resolvedResource: win32.normalize('D:\\projects\\MyAgent\\src\\index.ts'),
      }),
    ]));
  });

  it('追踪简单局部字符串变量，并保留 symbolic 来源', async () => {
    const analysis = await analyzeShellCommand(
      "$path = '.\\package.json'; Get-Content $path",
      'powershell',
      undefined,
      context,
    );

    expect(analysis.resourceAccesses).toContainEqual(expect.objectContaining({
      rawExpression: '$path',
      resolvedResource: win32.normalize('D:\\projects\\MyAgent\\package.json'),
      scope: 'workspace',
      certainty: 'symbolic',
    }));
  });

  it('保留通配路径为 pattern，而不是伪装成单一路径', async () => {
    const analysis = await analyzeShellCommand(
      'Get-ChildItem C:\\Users\\*',
      'powershell',
      undefined,
      context,
    );

    expect(analysis.resourceAccesses).toContainEqual(expect.objectContaining({
      kind: 'directory',
      rawExpression: 'C:\\Users\\*',
      certainty: 'pattern',
    }));
  });

  it('区分 copy 的源读取与目标写入', async () => {
    const analysis = await analyzeShellCommand(
      'Copy-Item .\\source.txt .\\target.txt',
      'powershell',
      undefined,
      context,
    );

    expect(analysis.resourceAccesses).toEqual(expect.arrayContaining([
      expect.objectContaining({ rawExpression: '.\\source.txt', operation: 'read' }),
      expect.objectContaining({ rawExpression: '.\\target.txt', operation: 'write' }),
    ]));
  });

  it('Bash cd 同样更新后续资源的有效 cwd', async () => {
    const analysis = await analyzeShellCommand(
      'cd src; cat index.ts',
      'posix',
      undefined,
      context,
    );

    expect(analysis.resourceAccesses).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'directory',
        operation: 'mutate',
        resolvedResource: win32.normalize('D:\\projects\\MyAgent\\src'),
      }),
      expect.objectContaining({
        kind: 'file',
        operation: 'read',
        baseContext: win32.normalize('D:\\projects\\MyAgent\\src'),
        resolvedResource: win32.normalize('D:\\projects\\MyAgent\\src\\index.ts'),
      }),
    ]));
  });

  it('按物理路径解析器识别工作区内链接的外部目标', async () => {
    const analysis = await analyzeShellCommand(
      'Get-Content .\\linked\\secret.txt',
      'powershell',
      undefined,
      {
        ...context,
        resolvePhysicalPath: path => path.includes('linked')
          ? 'D:\\external\\secret.txt'
          : path,
      },
    );

    expect(analysis.resourceAccesses).toContainEqual(expect.objectContaining({
      resolvedResource: win32.normalize('D:\\external\\secret.txt'),
      scope: 'external',
      certainty: 'exact',
    }));
  });

  it('物理路径解析失败时降级为 unknown，而不伪装为 workspace exact', async () => {
    const analysis = await analyzeShellCommand(
      'Get-Content .\\unreachable\\secret.txt',
      'powershell',
      undefined,
      {
        ...context,
        resolvePhysicalPath: () => { throw new Error('unreachable'); },
      },
    );

    expect(analysis.resourceAccesses).toContainEqual(expect.objectContaining({
      scope: 'unknown',
      certainty: 'unknown',
    }));
  });

  it('识别局部变量中的 provider，并用静态变量更新 cwd', async () => {
    const provider = await analyzeShellCommand(
      "$path = 'HKLM:\\Software'; Get-Item $path",
      'powershell',
      undefined,
      context,
    );
    const cwd = await analyzeShellCommand(
      "$dir = '.\\src'; Set-Location $dir; Get-Content .\\index.ts",
      'powershell',
      undefined,
      context,
    );

    expect(provider.resourceAccesses).toContainEqual(expect.objectContaining({
      kind: 'registry',
      rawExpression: '$path',
      resolvedResource: 'HKLM:\\Software',
    }));
    expect(cwd.resourceAccesses).toContainEqual(expect.objectContaining({
      kind: 'file',
      baseContext: win32.normalize('D:\\projects\\MyAgent\\src'),
      resolvedResource: win32.normalize('D:\\projects\\MyAgent\\src\\index.ts'),
    }));
  });
});
