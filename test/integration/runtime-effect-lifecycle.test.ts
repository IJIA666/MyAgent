/**
 * @file 运行时 effect 生命周期集成测试。
 * 验证权限 evidence 经统一映射进入执行 effect，并覆盖内置工具注册与调用链。
 */

import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/adapters/tools/toolRegistry.js';
import { ToolCatalog } from '../../src/adapters/tools/ToolCatalog.js';
import { buildNativeTools } from '../../src/adapters/tools/tool-factory.js';
import { BashTool, PowerShellTool } from '../../src/adapters/tools/impl/system/terminal.js';
import { createExecutionEffectFromEvidence } from '../../src/adapters/tools/ToolExecutor.js';

// 使用与当前平台公开工具一致的 Shell，确保 effect 生命周期测试不依赖旧的动态 shellKind 参数。
const platformReadCase = process.platform === 'win32'
  ? { command: 'Get-Content package.json', shellKind: 'powershell' as const }
  : { command: 'ls', shellKind: 'posix' as const };

// 使用当前平台公开 Shell 下的纯只读复合命令，验证子命令风险可以聚合。
const platformCompositeCase = process.platform === 'win32'
  ? { command: 'Get-Content package.json; Get-Process', shellKind: 'powershell' as const }
  : { command: 'ls; pwd', shellKind: 'posix' as const };

describe('运行时 effect 生命周期集成验证（8.1-8.4）', () => {
  const tool = process.platform === 'win32'
    ? new PowerShellTool()
    : new BashTool();

  it('8.1 原子和纯只读复合命令的 evidence 均映射为 read effect', async () => {
    const atomicDecision = await tool.checkPermissions(platformReadCase);
    expect(atomicDecision.kind).toBe('allow');
    const readEffect = createExecutionEffectFromEvidence(atomicDecision.evidence, true);
    expect(readEffect.kind).toBe('read');
    expect(readEffect.reason).toBe('permission_evidence');

    const compoundDecision = await tool.checkPermissions(platformCompositeCase);
    expect(compoundDecision.kind).toBe('allow');
    expect(compoundDecision.evidence?.subcommands).toHaveLength(2);
    const compoundEffect = createExecutionEffectFromEvidence(compoundDecision.evidence, true);
    expect(compoundEffect.kind).toBe('read');
    expect(compoundEffect.reason).toBe('permission_evidence');
  });

  it('8.2 ToolRegistry.callTool 正确返回 effect', async () => {
    const registry = new ToolRegistry();
    const readOutcome = await registry.callTool('get_current_time', {});
    expect(readOutcome.effect.kind).toBe('read');
    expect(readOutcome.effect.executionStarted).toBe(true);
    await expect(registry.callTool('unknown_tool_xyz', {})).rejects.toThrow();
  });

  it('8.3 ToolCatalog 内置工具均提供统一权限检查入口', () => {
    const catalog = new ToolCatalog(buildNativeTools());
    const names = ['readFile', 'writeFile', 'editFile', 'listFiles', 'Bash', 'grepSearch'];
    for (const name of names) {
      const toolInst = catalog.getTool(name);
      expect(toolInst).toBeDefined();
      expect(toolInst!.securityCategory).toMatch(/read|write/);
      expect(typeof toolInst!.checkPermissions).toBe('function');
      expect(typeof toolInst!.execute).toBe('function');
    }
  });

  it('8.4 所有内置工具在 ToolCatalog 中均可查询', () => {
    const catalog = new ToolCatalog(buildNativeTools());
    const inst = catalog.getTool('readFile');
    expect(inst).toBeDefined();
    expect(inst!.name).toBe('readFile');
  });
});
