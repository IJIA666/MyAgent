import { describe, expect, it } from 'vitest';
import { LocalFileSystemMcpServer } from '../../../src/adapters/tools/virtual-mcp.js';

describe('LocalFileSystemMcpServer 资源提取器', () => {
  it('应为 createDirectory 使用 directoryPath 提取写资源', () => {
    const server = new LocalFileSystemMcpServer();
    const extractor = server.getResourceExtractors().get('createDirectory');

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
    const server = new LocalFileSystemMcpServer();
    const extractor = server.getResourceExtractors().get('grepSearch');

    expect(extractor).toBeDefined();
    const resources = extractor!({ searchPath: 'src, test' });

    expect(resources).toHaveLength(2);
    expect(resources[0]).toMatchObject({ kind: 'path', access: 'read' });
    expect(resources[1]).toMatchObject({ kind: 'path', access: 'read' });
  });

  it('应为 execute_command 使用 extractSafePrefix 语义提取命令前缀', () => {
    const server = new LocalFileSystemMcpServer();
    const extractor = server.getResourceExtractors().get('execute_command');

    expect(extractor).toBeDefined();
    const resources = extractor!({ command: 'git status' });

    expect(resources).toEqual([{ kind: 'command-prefix', prefix: 'git status' }]);
  });

  it('包装命令无法提取安全前缀时，应返回空资源列表', () => {
    const server = new LocalFileSystemMcpServer();
    const extractor = server.getResourceExtractors().get('execute_command');

    expect(extractor).toBeDefined();
    const resources = extractor!({ command: 'bash -lc "git status"' });

    expect(resources).toEqual([]);
  });
});
