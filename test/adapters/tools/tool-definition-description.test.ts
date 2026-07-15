/**
 * @file tool-definition-description.test.ts
 * @description 锁定工具描述中的中性边界措辞，避免模型被“越界即拒绝”的文案误导。
 */

import { describe, expect, test } from 'vitest';
import { ReadFileTool, WriteFileTool, EditFileTool, ListFilesTool } from '../../../src/adapters/tools/impl/filesystem/file-system.js';
import { CreateDirectoryTool, DeletePathTool } from '../../../src/adapters/tools/impl/filesystem/directory-manager.js';
import { GrepSearchTool, GlobSearchTool } from '../../../src/adapters/tools/impl/filesystem/search.js';
import { ReadManyFilesTool } from '../../../src/adapters/tools/impl/filesystem/read-many-files.js';
import { BashTool, PowerShellTool } from '../../../src/adapters/tools/impl/system/terminal.js';
import { buildSystemTools } from '../../../src/adapters/tools/impl/system/index.js';
import { isShellKindSupportedOnPlatform } from '../../../src/adapters/tools/impl/system/terminal-plan.js';

describe('工具描述中性边界约束', () => {
  test('ListFilesTool 描述应包含预算参数和默认不递归说明', () => {
    const listTool = new ListFilesTool();
    const fnDef = listTool.definition.function as {
      description: string;
      parameters: { properties: Record<string, unknown> };
    };
    const desc = fnDef.description;
    expect(desc).toContain('直接子项');
    expect(desc).toContain('默认仅返回名称列表');

    const props = fnDef.parameters.properties;
    expect(props).toHaveProperty('includeDirectoryStats');
    expect(props).toHaveProperty('compareDirectories');
    expect(props).toHaveProperty('maxDepth');
    expect(props).toHaveProperty('maxEntries');
    expect(props).toHaveProperty('maxBytes');
    expect(props).toHaveProperty('maxDurationMs');
  });
  test('文件工具描述应保留默认工作区边界并委托工具层裁决', () => {
    const tools = [
      new ReadFileTool(),
      new WriteFileTool(),
      new EditFileTool(),
      new ListFilesTool(),
      new CreateDirectoryTool(),
      new DeletePathTool(),
      new GrepSearchTool(),
      new GlobSearchTool(),
      new ReadManyFilesTool(),
    ];

    for (const tool of tools) {
      const description = tool.definition.function.description;
      expect(description).toContain('默认在工作区内');
      expect(description).toContain('外部路径由工具层依据安全策略处理');
      expect(description).not.toContain('授权工作区');
    }
  });

  test('Bash 与 PowerShell 应作为独立工具暴露且不携带 shellKind 参数', () => {
    const bashTool = new BashTool();
    const powerShellTool = new PowerShellTool();
    const bashDefinition = bashTool.definition.function as {
      name: string;
      parameters: { properties: Record<string, unknown> };
    };
    const powerShellDefinition = powerShellTool.definition.function as {
      name: string;
      parameters: { properties: Record<string, unknown> };
    };

    expect(bashTool.name).toBe('Bash');
    expect(powerShellTool.name).toBe('PowerShell');
    expect(bashDefinition.name).toBe('Bash');
    expect(powerShellDefinition.name).toBe('PowerShell');
    expect(bashDefinition.parameters.properties).not.toHaveProperty('shellKind');
    expect(powerShellDefinition.parameters.properties).not.toHaveProperty('shellKind');
  });

  test('系统工具工厂应始终注册 Bash，并仅在 Windows 能力可用时注册 PowerShell', () => {
    const names = buildSystemTools().map((tool) => tool.name);
    const shouldExposePowerShell = process.platform === 'win32' &&
      isShellKindSupportedOnPlatform('powershell', 'win32');

    expect(names).toContain('Bash');
    expect(names.includes('PowerShell')).toBe(shouldExposePowerShell);
  });
});
