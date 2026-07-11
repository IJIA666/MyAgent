/**
 * @file tool-definition-description.test.ts
 * @description 锁定工具描述中的中性边界措辞，避免模型被“越界即拒绝”的文案误导。
 */

import { describe, expect, test } from 'vitest';
import { ReadFileTool, WriteFileTool, EditFileTool, ListFilesTool } from '../../../src/adapters/tools/impl/filesystem/file-system.js';
import { CreateDirectoryTool, DeletePathTool } from '../../../src/adapters/tools/impl/filesystem/directory-manager.js';
import { GrepSearchTool, GlobSearchTool } from '../../../src/adapters/tools/impl/filesystem/search.js';
import { ReadManyFilesTool } from '../../../src/adapters/tools/impl/filesystem/read-many-files.js';
import { ExecuteCommandTool } from '../../../src/adapters/tools/impl/system/terminal.js';

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

  test('终端工具描述应保留沙箱约束但不再预判外部路径必然拒绝', () => {
    const description = new ExecuteCommandTool().definition.function.description;

    expect(description).toContain('在工作区沙箱内执行');
    expect(description).toContain('外部路径由安全策略管控');
    expect(description).not.toContain('受限的工作区沙箱');
    expect(description).not.toContain('禁止读写工作区外部路径');
  });
});
