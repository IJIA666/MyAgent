/**
 * @file 全局副作用入口覆盖契约测试。
 * 从真实 NativeTool 工厂反向核对 manifest、adapter 和执行边界，
 * 防止新增工具、tail call、MCP 或公开写 helper 绕过统一授权网关。
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EFFECTFUL_ENTRYPOINTS,
  type EffectfulEntrypoint,
} from '../../src/adapters/tools/effectful-entrypoints.js';
import { ToolCatalog } from '../../src/adapters/tools/ToolCatalog.js';
import { buildNativeTools } from '../../src/adapters/tools/tool-factory.js';
import type { NativeTool } from '../../src/adapters/tools/tool-types.js';
import type { ToolAuthorizationAdapter } from '../../src/ports/driven/tools/ToolAuthorizationAdapter.js';

/** 返回 manifest 中能够与静态 NativeTool 工厂一一核对的记录。 */
function getManifestToolEntries(): readonly EffectfulEntrypoint[] {
  return EFFECTFUL_ENTRYPOINTS.filter(entry =>
    entry.kind === 'native-tool'
    || entry.kind === 'terminal'
    || entry.kind === 'plugin');
}

/** 构造最小的 NativeTool 探针。 */
function createProbeTool(
  name: string,
  adapter?: ToolAuthorizationAdapter,
): NativeTool {
  return {
    name,
    securityCategory: 'write',
    definition: { type: 'function', function: { name } },
    authorizationAdapter: adapter,
    execute: () => 'ok',
  };
}

describe('全局副作用入口清单', () => {
  it('所有清单 sourcePath 必须指向真实源码且名称不可重复', () => {
    const names = new Set<string>();
    for (const entry of EFFECTFUL_ENTRYPOINTS) {
      expect(existsSync(resolve(process.cwd(), entry.sourcePath))).toBe(true);
      const key = `${entry.kind}:${entry.name}`;
      expect(names.has(key)).toBe(false);
      names.add(key);
    }
  });

  it('真实工厂中的所有 write 工具必须在清单中并携带精确 adapter', () => {
    const tools = buildNativeTools();
    const catalog = new ToolCatalog(tools);
    const manifestNames = new Set(getManifestToolEntries().map(entry => entry.name));

    for (const tool of tools) {
      if (tool.securityCategory !== 'write') continue;
      expect(manifestNames.has(tool.name)).toBe(true);
      expect(tool.authorizationAdapter?.runtimeToolName).toBe(tool.name);
      expect(catalog.getAuthorizedTools().get(tool.name)).toBe(tool.authorizationAdapter);
    }
  });

  it('清单中的静态工具不得是拼错名称的幽灵入口', () => {
    const actualToolNames = new Set(buildNativeTools().map(tool => tool.name));
    for (const entry of getManifestToolEntries()) {
      expect(actualToolNames.has(entry.name)).toBe(true);
      if (entry.sideEffect === 'write' || entry.sideEffect === 'mixed') {
        expect(entry.adapterName).toBeTruthy();
      }
    }
  });

  it('ToolCatalog 对缺失、错绑和重复 adapter 均 fail closed', () => {
    expect(() => new ToolCatalog([createProbeTool('missing')])).toThrow(
      '缺少 authorizationAdapter',
    );
    const wrongAdapter: ToolAuthorizationAdapter = {
      runtimeToolName: 'other',
      permissionIdentity: 'UnknownEffect',
      adapterVersion: 'test',
      buildPermissionRequest: () => {
        throw new Error('测试不执行适配器');
      },
      buildApprovalOptions: () => [],
      isOrdinaryEdit: () => false,
    };
    expect(() => new ToolCatalog([createProbeTool('mismatch', wrongAdapter)])).toThrow(
      '错绑权限适配器',
    );

    const readProbe: NativeTool = {
      name: 'duplicate',
      securityCategory: 'read',
      definition: { type: 'function', function: { name: 'duplicate' } },
      execute: () => 'ok',
    };
    expect(() => new ToolCatalog([readProbe, readProbe])).toThrow('重复注册');
  });

  it('tail call 必须重新调用 ToolRegistry，MCP 必须走外部 Gateway', () => {
    const orchestrator = readFileSync(
      resolve(process.cwd(), 'src/core/usecases/engine/tool-call-orchestrator.ts'),
      'utf8',
    );
    const registry = readFileSync(
      resolve(process.cwd(), 'src/adapters/tools/toolRegistry.ts'),
      'utf8',
    );
    expect(orchestrator).toContain('const tailOutcome = await this.toolRegistry.callTool(');
    expect(registry).toContain('this.gateway.executeExternal(');
  });

  it('公开递归写 helper 只能由已授权目录工具模块调用', () => {
    const helper = readFileSync(
      resolve(process.cwd(), 'src/adapters/tools/impl/filesystem/directory-manager-helper.ts'),
      'utf8',
    );
    const authorizedCaller = readFileSync(
      resolve(process.cwd(), 'src/adapters/tools/impl/filesystem/directory-manager.ts'),
      'utf8',
    );
    const factory = readFileSync(
      resolve(process.cwd(), 'src/adapters/tools/tool-factory.ts'),
      'utf8',
    );

    expect(helper).toContain('export function copyRecursiveSync');
    expect(authorizedCaller).toContain("from './directory-manager-helper.js'");
    expect(factory).not.toContain('directory-manager-helper');
  });
});
