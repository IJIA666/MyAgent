/**
 * @fileoverview AgentDefinitionLoader 单测：frontmatter 解析、必填字段、值域校验、
 * 未启用字段 warning、目录容错与 memoize。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentDefinitionLoader } from '../../../../src/core/usecases/subagent/AgentDefinitionLoader.js';
import { compileDefinitionToolVisibility } from '../../../../src/core/usecases/subagent/ScopedToolRegistry.js';
import { logger } from '../../../../src/utils/logger.js';

describe('AgentDefinitionLoader', () => {
  let root: string;
  let userAgentsDir: string;
  let projectAgentsDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-loader-'));
    userAgentsDir = join(root, 'user-agents');
    projectAgentsDir = join(root, 'project-agents');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  /** 写入一个定义文件并返回路径。 */
  function writeAgent(layer: 'user' | 'project', fileName: string, content: string): string {
    const dir = layer === 'user' ? userAgentsDir : projectAgentsDir;
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, fileName);
    writeFileSync(filePath, content, 'utf8');
    return filePath;
  }

  it('解析合法定义：name 为类型名、正文为系统提示、tools 支持数组与逗号分隔', () => {
    writeAgent('project', 'docs-agent.md', [
      '---',
      'name: docs-agent',
      'description: 文档助手',
      'tools: [readFile, globSearch]',
      'maxTurns: 10',
      'permissionMode: plan',
      'omitClaudeMd: true',
      '---',
      '你是文档专家。',
    ].join('\n'));
    writeAgent('user', 'reviewer.md', [
      '---',
      'name: reviewer',
      'description: 代码评审',
      'disallowedTools: writeFile, editFile',
      '---',
      '你是评审员。',
    ].join('\n'));

    const loader = new AgentDefinitionLoader(userAgentsDir, projectAgentsDir);
    const definitions = loader.load();

    // user 层在前、project 层在后（优先级由注册表消费）。
    expect(definitions.map(definition => definition.type)).toEqual(['reviewer', 'docs-agent']);
    const docs = definitions.find(definition => definition.type === 'docs-agent');
    expect(docs).toMatchObject({
      sourceDir: 'project',
      tools: ['readFile', 'globSearch'],
      maxTurns: 10,
      permissionMode: 'plan',
      omitClaudeMd: true,
      systemPrompt: '你是文档专家。',
    });
    const reviewer = definitions.find(definition => definition.type === 'reviewer');
    expect(reviewer?.disallowedTools).toEqual(['writeFile', 'editFile']);
  });

  it('缺少必填 name/description 或非法 frontmatter 时拒绝单文件', () => {
    writeAgent('project', 'no-name.md', [
      '---',
      'description: 缺 name',
      '---',
      '正文',
    ].join('\n'));
    writeAgent('project', 'no-desc.md', [
      '---',
      'name: no-desc',
      '---',
      '正文',
    ].join('\n'));
    writeAgent('project', 'bad-yaml.md', '---\nname: [broken\n---\n正文');
    writeAgent('project', 'good.md', [
      '---',
      'name: good',
      'description: 合法定义',
      '---',
      '正文',
    ].join('\n'));

    const loader = new AgentDefinitionLoader(userAgentsDir, projectAgentsDir);
    expect(loader.load().map(definition => definition.type)).toEqual(['good']);
  });

  it('未知 model / 非 plan permissionMode / 非法 maxTurns 时拒绝定义', () => {
    writeAgent('project', 'bad-model.md', [
      '---',
      'name: bad-model',
      'description: 坏模型',
      'model: haiku',
      '---',
      '正文',
    ].join('\n'));
    writeAgent('project', 'bad-mode.md', [
      '---',
      'name: bad-mode',
      'description: 坏权限',
      'permissionMode: acceptEdits',
      '---',
      '正文',
    ].join('\n'));
    writeAgent('project', 'bad-turns.md', [
      '---',
      'name: bad-turns',
      'description: 坏上限',
      'maxTurns: 0',
      '---',
      '正文',
    ].join('\n'));

    const loader = new AgentDefinitionLoader(userAgentsDir, projectAgentsDir);
    expect(loader.load()).toHaveLength(0);
  });

  it('未启用字段解析但忽略并记录 warning', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    writeAgent('project', 'deferred.md', [
      '---',
      'name: deferred',
      'description: 带未启用字段',
      'memory: project',
      'hooks: {}',
      '---',
      '正文',
    ].join('\n'));

    const loader = new AgentDefinitionLoader(userAgentsDir, projectAgentsDir);
    const definitions = loader.load();

    expect(definitions).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    const deferredCalls = warn.mock.calls.filter(call => String(call[0]).includes('未启用'));
    expect(deferredCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('background: true 解析生效且不记录未启用 warning', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    writeAgent('project', 'bg-agent.md', [
      '---',
      'name: bg-agent',
      'description: 强制后台代理',
      'background: true',
      '---',
      '正文',
    ].join('\n'));

    const loader = new AgentDefinitionLoader(userAgentsDir, projectAgentsDir);
    const definition = loader.load()[0];
    expect(definition?.background).toBe(true);
    // background 已启用：不得出现在"未启用字段"warning 中。
    const deferredCalls = warn.mock.calls.filter(call => String(call[0]).includes('未启用'));
    expect(deferredCalls).toHaveLength(0);
  });

  it('background: false 视为未声明', () => {
    writeAgent('project', 'bg-false.md', [
      '---',
      'name: bg-false',
      'description: 显式非后台',
      'background: false',
      '---',
      '正文',
    ].join('\n'));

    const loader = new AgentDefinitionLoader(userAgentsDir, projectAgentsDir);
    const definition = loader.load()[0];
    expect(definition?.background).toBeUndefined();
  });

  it('非法 background 值拒绝定义（fail-closed）', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    writeAgent('project', 'bg-invalid.md', [
      '---',
      'name: bg-invalid',
      'description: 非法后台值',
      'background: "yes"',
      '---',
      '正文',
    ].join('\n'));

    const loader = new AgentDefinitionLoader(userAgentsDir, projectAgentsDir);
    expect(loader.load()).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('background 必须为布尔值'),
      expect.objectContaining({ event: 'agent_invalid_background' }),
    );
  });

  it('目录不存在时返回空结果', () => {
    const loader = new AgentDefinitionLoader(userAgentsDir, projectAgentsDir);
    expect(loader.load()).toEqual([]);
  });

  it('显式声明空 tools 保持空名单（fail-closed），不回退默认全池', () => {
    writeAgent('project', 'no-tools.md', [
      '---',
      'name: no-tools',
      'description: 显式空名单',
      'tools: []',
      '---',
      '正文',
    ].join('\n'));

    const loader = new AgentDefinitionLoader(userAgentsDir, projectAgentsDir);
    const definition = loader.load()[0];
    expect(definition?.tools).toEqual([]);
    // 空允许名单编译后任何工具都不可见（fail-closed）。
    const predicate = compileDefinitionToolVisibility(definition?.tools, undefined);
    expect(predicate?.('readFile')).toBe(false);
    expect(predicate?.('Bash')).toBe(false);
  });

  it('mcpServers 支持引用/内联/混合解析，非法项拒绝且不影响其余', () => {
    writeAgent('project', 'mcp-agent.md', [
      '---',
      'name: mcp-agent',
      'description: 带 MCP 声明',
      'mcpServers:',
      '  - slack',
      '  - review-db:',
      '      command: npx',
      '      args: [review-db-mcp]',
      '  - 42',
      '---',
      '正文',
    ].join('\n'));

    const loader = new AgentDefinitionLoader(userAgentsDir, projectAgentsDir);
    const definitions = loader.load();
    expect(definitions).toHaveLength(1);
    const definition = definitions[0];
    // 合法两项保留（引用 + 内联），非法项 42 被拒绝。
    expect(definition?.mcpServers).toEqual([
      'slack',
      { name: 'review-db', config: { command: 'npx', args: ['review-db-mcp'] } },
    ]);
    expect(definition?.systemPrompt).toBe('正文');
  });

  it('tools 通配符恰好 [*] 归一化为未声明（默认池语义）', () => {
    writeAgent('project', 'wildcard.md', [
      '---',
      'name: wildcard',
      'description: 通配名单',
      'tools: ["*"]',
      '---',
      '正文',
    ].join('\n'));

    const loader = new AgentDefinitionLoader(userAgentsDir, projectAgentsDir);
    const definition = loader.load()[0];
    expect(definition?.tools).toBeUndefined();
  });

  it('initialPrompt 解析为非空字符串', () => {
    writeAgent('project', 'prompted.md', [
      '---',
      'name: prompted',
      'description: 带开场白',
      'initialPrompt: 以评审模式开始',
      '---',
      '正文',
    ].join('\n'));

    const loader = new AgentDefinitionLoader(userAgentsDir, projectAgentsDir);
    const definition = loader.load()[0];
    expect(definition?.initialPrompt).toBe('以评审模式开始');
  });

  it('memoize：重复 load 返回同一缓存快照', () => {
    writeAgent('project', 'cached.md', [
      '---',
      'name: cached',
      'description: 缓存定义',
      '---',
      '正文',
    ].join('\n'));
    const loader = new AgentDefinitionLoader(userAgentsDir, projectAgentsDir);
    expect(loader.load()).toBe(loader.load());
  });
});
