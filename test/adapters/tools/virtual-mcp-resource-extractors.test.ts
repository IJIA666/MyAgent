/**
 * @file virtual-mcp-resource-extractors.test.ts
 * @description 验证统一本地工具运行时中的资源提取器聚合行为。
 */

import { describe, expect, it } from 'vitest';
import { buildNativeTools } from '../../../src/adapters/tools/tool-factory.js';
import { ToolAccessMetadataProvider } from '../../../src/adapters/tools/ToolAccessMetadataProvider.js';

describe('ToolAccessMetadataProvider 资源提取器（统一运行时版本）', () => {
  /** 创建 provider 的辅助函数——直接基于统一工具装配源构建。 */
  function createProvider(): ToolAccessMetadataProvider {
    return new ToolAccessMetadataProvider(buildNativeTools());
  }

  it('应为 createDirectory 使用 directoryPath 提取写资源', () => {
    const provider = createProvider();
    const extractor = provider.getResourceExtractor('createDirectory');

    expect(extractor).toBeDefined();
    const resources = extractor!({ directoryPath: 'tmp/output' });

    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({
      kind: 'path',
      access: 'write'
    });
    expect((resources[0] as { normalizedPath: string }).normalizedPath).toContain('tmp');
  });

  it('应为 grepSearch 使用 searchPath 提取只读资源', () => {
    const provider = createProvider();
    const extractor = provider.getResourceExtractor('grepSearch');

    expect(extractor).toBeDefined();
    const resources = extractor!({ searchPath: 'src, test' });

    expect(resources).toHaveLength(2);
    expect(resources[0]).toMatchObject({ kind: 'path', access: 'read' });
    expect(resources[1]).toMatchObject({ kind: 'path', access: 'read' });
  });

  it('应为 execute_command 使用 extractSafePrefix 语义提取命令前缀', () => {
    const provider = createProvider();
    const extractor = provider.getResourceExtractor('execute_command');

    expect(extractor).toBeDefined();
    const resources = extractor!({ command: 'git status' });

    expect(resources).toEqual([{ kind: 'command-prefix', prefix: 'git status' }]);
  });

  it('包装命令无法提取安全前缀时，应返回空资源列表', () => {
    const provider = createProvider();
    const extractor = provider.getResourceExtractor('execute_command');

    expect(extractor).toBeDefined();
    const resources = extractor!({ command: 'bash -lc "git status"' });

    expect(resources).toEqual([]);
  });
});
