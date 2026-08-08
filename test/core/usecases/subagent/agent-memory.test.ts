/**
 * @fileoverview 子代理持久记忆模块单测：三域目录解析、安全名称校验、提示词构造。
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplicationPaths } from '../../../../src/config/application-paths.js';
import {
  buildAgentMemoryPrompt,
  getAgentMemoryDir,
  isSafeAgentTypeName,
  sanitizeAgentTypeForPath,
} from '../../../../src/core/usecases/subagent/agent-memory.js';

/** 创建注入临时根的应用路径。 */
function createTestPaths(): ReturnType<typeof createApplicationPaths> {
  const root = mkdtempSync(join(tmpdir(), 'agent-memory-'));
  try {
    return createApplicationPaths(join(root, 'workspace'), { appDataRoot: join(root, 'data') });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('getAgentMemoryDir', () => {
  it('三个作用域解析到各自基座', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-memory-dir-'));
    try {
      const paths = createApplicationPaths(join(root, 'workspace'), { appDataRoot: join(root, 'data') });
      expect(getAgentMemoryDir('reviewer', 'user', paths))
        .toBe(join(paths.userAgentMemoryBase, 'reviewer'));
      expect(getAgentMemoryDir('reviewer', 'project', paths))
        .toBe(join(paths.projectAgentMemoryBase, 'reviewer'));
      expect(getAgentMemoryDir('reviewer', 'local', paths))
        .toBe(join(paths.localAgentMemoryBase, 'reviewer'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('插件命名空间冒号消毒为短横线', () => {
    expect(sanitizeAgentTypeForPath('my-plugin:reviewer')).toBe('my-plugin-reviewer');
    const paths = createTestPaths();
    expect(getAgentMemoryDir('my-plugin:reviewer', 'user', paths))
      .toBe(join(paths.userAgentMemoryBase, 'my-plugin-reviewer'));
  });

  it('不安全类型名拒绝解析', () => {
    const paths = createTestPaths();
    expect(() => getAgentMemoryDir('../shared', 'user', paths)).toThrow();
  });
});

describe('isSafeAgentTypeName', () => {
  it('合法名称通过', () => {
    expect(isSafeAgentTypeName('reviewer')).toBe(true);
    expect(isSafeAgentTypeName('my-plugin:reviewer')).toBe(true);
    expect(isSafeAgentTypeName('docs-agent')).toBe(true);
  });

  it('路径分隔符与路径段拒绝', () => {
    expect(isSafeAgentTypeName('../shared')).toBe(false);
    expect(isSafeAgentTypeName('a/b')).toBe(false);
    expect(isSafeAgentTypeName('a\\b')).toBe(false);
    expect(isSafeAgentTypeName('.')).toBe(false);
    expect(isSafeAgentTypeName('..')).toBe(false);
    expect(isSafeAgentTypeName('/etc')).toBe(false);
    expect(isSafeAgentTypeName('C:\\x')).toBe(false);
  });

  it('Windows 保留设备名拒绝（含任意扩展形态）', () => {
    expect(isSafeAgentTypeName('CON')).toBe(false);
    expect(isSafeAgentTypeName('con')).toBe(false);
    expect(isSafeAgentTypeName('CON.md')).toBe(false);
    expect(isSafeAgentTypeName('CON.txt')).toBe(false);
    expect(isSafeAgentTypeName('NUL.json')).toBe(false);
    expect(isSafeAgentTypeName('COM1.log')).toBe(false);
    expect(isSafeAgentTypeName('LPT9')).toBe(false);
    expect(isSafeAgentTypeName('AUX')).toBe(false);
    expect(isSafeAgentTypeName('NUL')).toBe(false);
  });

  it('Windows 尾随点/空格名称拒绝（规范化后指向同名）', () => {
    expect(isSafeAgentTypeName('CON.')).toBe(false);
    expect(isSafeAgentTypeName('CON ')).toBe(false);
    expect(isSafeAgentTypeName('agent.')).toBe(false);
    expect(isSafeAgentTypeName('agent ')).toBe(false);
  });

  it('空白名称拒绝', () => {
    expect(isSafeAgentTypeName('')).toBe(false);
    expect(isSafeAgentTypeName('  ')).toBe(false);
  });
});

describe('buildAgentMemoryPrompt', () => {
  it('包含作用域说明、两步流程、type 四值、保留名禁令与绝对路径', () => {
    const prompt = buildAgentMemoryPrompt('project', 'D:\\mem\\project-agent');

    expect(prompt).toContain('project 作用域的记忆');
    expect(prompt).toContain('D:\\mem\\project-agent');
    expect(prompt).toContain('<slug>.md');
    expect(prompt).toContain('name: {{清晰、稳定的主题名称}}');
    expect(prompt).toContain('type: {{user、feedback、project、reference 四选一}}');
    expect(prompt).toContain('- [简洁标题](<slug>.md) — 一行相关性摘要');
    expect(prompt).toContain('不得为 `memory.md`');
    expect(prompt).toContain('先删除主题文件');
  });

  it('三个作用域的 scope note 各不相同', () => {
    const user = buildAgentMemoryPrompt('user', '/u');
    const project = buildAgentMemoryPrompt('project', '/p');
    const local = buildAgentMemoryPrompt('local', '/l');

    expect(user).toContain('user 作用域的记忆');
    expect(project).toContain('project 作用域的记忆');
    expect(local).toContain('local 作用域的记忆');
    expect(user).not.toContain('project 作用域');
  });
});
