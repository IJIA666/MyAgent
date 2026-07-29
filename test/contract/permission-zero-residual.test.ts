/**
 * @file 零残留扫描测试。
 * 扫描 `src/` 下不应再出现的遗留权限类型与符号。
 * 所有旧权限中心、临时白名单和兼容授权符号都必须严格为零。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';

/** 扫描 src/ 下所有 .ts 文件（排除 node_modules 和 dist）。 */
function* walkTsFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
        yield* walkTsFiles(fullPath);
      }
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      yield fullPath;
    }
  }
}

/** 读文件并检查某个字符串的出现次数。 */
function countOccurrences(filePath: string, pattern: string): number {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return content.split(pattern).length - 1;
  } catch {
    return 0;
  }
}

describe('零残留扫描', () => {
  const srcDir = resolve(import.meta.dirname ?? __dirname, '../../src');

  describe('旧权限架构严格零残留', () => {
    const forbiddenSymbols = [
      'WorkMode',
      'ApprovalPolicy',
      'ApprovalService',
      'SafetyCheckResult',
      'SafetyOperation',
      'PendingGrant',
      'CallCapability',
      'temporaryWhitelist',
      'TemporaryWhitelist',
      'auto-classifier',
      'ToolPermissionResourceEvidence',
      'isStructuredResourceEvidence',
      'ToolAccessMetadataProvider',
      'ToolAccessMetadataPort',
      'ResourceExtractor',
      'resourceExtractor',
      'accessMetadata',
    ];

    for (const symbol of forbiddenSymbols) {
      it(`${symbol} 在 src 中应为零`, () => {
        let count = 0;
        for (const file of walkTsFiles(srcDir)) {
          count += countOccurrences(file, symbol);
        }
        expect(count).toBe(0);
      });
    }

    it('旧权限实现文件不应继续存在', () => {
      const names = [...walkTsFiles(srcDir)].map(file => relative(srcDir, file).replace(/\\/g, '/'));
      expect(names).not.toEqual(expect.arrayContaining([
        'core/domain/call-capability.ts',
        'core/domain/authorization-state.ts',
        'core/domain/whitelist-access.ts',
        'core/usecases/security/ApprovalPolicy.ts',
        'core/usecases/security/ApprovalService.ts',
        'core/usecases/security/SecurityService.ts',
        'ports/driven/session/CallCapabilityPort.ts',
        'ports/driven/tools/ToolAccessMetadataPort.ts',
        'adapters/tools/ToolAccessMetadataProvider.ts',
        'adapters/tools/impl/resource-extractors.ts',
      ]));
    });
  });

  // ── 通用覆盖率 ──

  it('src 目录可读', () => {
    expect(statSync(srcDir).isDirectory()).toBe(true);
  });

  it('walkTsFiles 至少能找到 50 个 .ts 文件', () => {
    const files = [...walkTsFiles(srcDir)];
    expect(files.length).toBeGreaterThanOrEqual(50);
  });

  it('PermissionMode 生产联合不得重新包含 auto', () => {
    const permissionTypesPath = resolve(
      srcDir,
      'core/domain/permissions/permission-types.ts',
    );
    const content = readFileSync(permissionTypesPath, 'utf-8');
    const modeDeclaration = content.match(
      /export type PermissionMode\s*=([\s\S]*?);/,
    )?.[0] ?? '';

    expect(modeDeclaration).not.toMatch(/['"]auto['"]/);
  });

  it('正式资源证据不得保留宽泛字典兼容口', () => {
    const permissionTypesPath = resolve(
      srcDir,
      'core/domain/permissions/permission-types.ts',
    );
    const content = readFileSync(permissionTypesPath, 'utf-8');
    const evidenceDeclaration = content.match(
      /export type ResourceEvidence\s*=([\s\S]*?);/,
    )?.[0] ?? '';

    expect(evidenceDeclaration).not.toContain('Record<string, unknown>');
    expect(evidenceDeclaration).toContain('FileResourceEvidence');
    expect(evidenceDeclaration).toContain('UnknownResourceEvidence');
  });
});
