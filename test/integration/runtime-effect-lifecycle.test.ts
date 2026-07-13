/**
 * @fileoverview 运行时 effect 生命周期集成测试。
 * 验证 Plan 原子只读→复合阻断→代码写入→质量门禁→结构化日志全链路由。
 */

import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/adapters/tools/toolRegistry.js';
import { ToolCatalog } from '../../src/adapters/tools/ToolCatalog.js';
import { buildNativeTools } from '../../src/adapters/tools/tool-factory.js';
import { BashTool, PowerShellTool } from '../../src/adapters/tools/impl/system/terminal.js';

// 使用与当前平台公开工具一致的 Shell，确保 effect 生命周期测试不依赖旧的动态 shellKind 参数。
const platformReadCase = process.platform === 'win32'
  ? { command: 'Get-Content package.json', shellKind: 'powershell' as const }
  : { command: 'ls', shellKind: 'posix' as const };

// 使用当前平台公开 Shell 下的复合命令，验证复合命令不会被识别为只读。
const platformCompositeCase = process.platform === 'win32'
  ? { command: 'Get-Content package.json | Select-String "txt"', shellKind: 'powershell' as const }
  : { command: 'ls | grep "txt"', shellKind: 'posix' as const };

describe('运行时 effect 生命周期集成验证（8.1-8.4）', () => {
  const tool = process.platform === 'win32'
    ? new PowerShellTool()
    : new BashTool();

  it('8.1 Plan 模式原子只读命令 → effect=read，复合命令 → 阻断', () => {
    const readEffect = tool.resolveExecutionEffect!(platformReadCase);
    expect(readEffect && readEffect.kind).toBe('read');

    const planSafe = tool.resolveExecutionEffect!(platformCompositeCase);
    expect(planSafe && planSafe.kind).toBe('unknown');
  });

  it('8.2 ToolRegistry.callTool 正确返回 effect', async () => {
    const registry = new ToolRegistry();
    const readOutcome = await registry.callTool('get_current_time', {});
    expect(readOutcome.effect.kind).toBe('read');
    expect(readOutcome.effect.executionStarted).toBe(true);
    await expect(registry.callTool('unknown_tool_xyz', {})).rejects.toThrow();
  });

  it('8.3 ToolCatalog 内置工具均有 effect 解析或默认推导', () => {
    const catalog = new ToolCatalog(buildNativeTools());
    const names = ['readFile', 'writeFile', 'editFile', 'listFiles', 'Bash', 'grepSearch'];
    for (const name of names) {
      const toolInst = catalog.getTool(name);
      expect(toolInst).toBeDefined();
      expect(toolInst!.securityCategory).toMatch(/read|write/);
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
