/**
 * @file Claude 风格长期记忆索引加载器测试。
 * 覆盖只读 MEMORY.md、200 行/25KB 上限、topic 按需读取与不可变快照。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  diagnoseMemoryTopics,
  loadMemorySnapshot,
} from '../../../../src/core/usecases/brain/memory-loader.js';

/** 生成一条合法索引行（平铺格式，无 topics/ 前缀）。 */
function indexLine(index: number, description = '描述'): string {
  return `- [主题 ${index}](topic-${index}.md) — ${description}`;
}

describe('loadMemorySnapshot', () => {
  let memoryDir: string;

  beforeEach(() => {
    memoryDir = mkdtempSync(join(tmpdir(), 'myagent-memory-loader-'));
  });

  afterEach(() => {
    rmSync(memoryDir, { recursive: true, force: true });
  });

  it('MEMORY.md 缺失时返回合法空快照且不创建文件', () => {
    const result = loadMemorySnapshot(memoryDir);

    expect(result.status).toBe('empty');
    expect(result.snapshot).toMatchObject({
      memoryDir,
      content: '',
      isEmpty: true,
      isTruncated: false,
    });
    expect(existsSync(join(memoryDir, 'MEMORY.md'))).toBe(false);
    expect(Object.isFrozen(result.snapshot)).toBe(true);
  });

  it('启动加载只读取 MEMORY.md，不打开或解释 topic frontmatter', () => {
    const content = `${indexLine(1)}\n`;
    writeFileSync(
      join(memoryDir, 'topic-1.md'),
      '---\ntype: unknown\n---\n不应在启动时读取',
      'utf-8',
    );
    writeFileSync(join(memoryDir, 'MEMORY.md'), content, 'utf-8');

    const result = loadMemorySnapshot(memoryDir);

    expect(result.status).toBe('loaded');
    expect(result.snapshot.content).toBe(content);
    expect(result.snapshot.topics).toEqual([
      expect.objectContaining({
        slug: 'topic-1',
        title: '主题 1',
        type: undefined,
      }),
    ]);
    expect(result.diagnostic.unknownTypes).toEqual([]);
    expect(result.diagnostic.invalidFrontmatter).toEqual([]);
    expect(result.diagnostic.brokenLinks).toEqual([]);
  });

  it('任意非空 MEMORY.md 都是可注入索引内容，不要求必须采用 topic 列表格式', () => {
    const content = '# 项目记忆\n\n用户偏好简体中文。\n';
    writeFileSync(join(memoryDir, 'MEMORY.md'), content, 'utf-8');

    const result = loadMemorySnapshot(memoryDir);

    expect(result.snapshot.content).toBe(content);
    expect(result.snapshot.isEmpty).toBe(false);
    expect(result.snapshot.topics).toEqual([]);
  });

  it('恰好 200 行不截断，超过 200 行只保留前 200 行', () => {
    const twoHundred = Array.from({ length: 200 }, (_, index) => indexLine(index));
    writeFileSync(join(memoryDir, 'MEMORY.md'), `${twoHundred.join('\n')}\n`, 'utf-8');

    const exact = loadMemorySnapshot(memoryDir);
    expect(exact.snapshot.isTruncated).toBe(false);
    expect(exact.snapshot.content.split('\n').filter(Boolean)).toHaveLength(200);

    const overflow = [...twoHundred, indexLine(200)];
    writeFileSync(join(memoryDir, 'MEMORY.md'), `${overflow.join('\n')}\n`, 'utf-8');
    const truncated = loadMemorySnapshot(memoryDir);
    expect(truncated.snapshot.isTruncated).toBe(true);
    expect(truncated.snapshot.content.split('\n').filter(Boolean)).toHaveLength(200);
    expect(truncated.diagnostic.truncation).toEqual({
      reason: 'line_limit',
      limit: 200,
    });
  });

  it('超过 25KB 时按最后一个完整换行截断，不保留半个 UTF-8 字符或半行', () => {
    const lines = Array.from(
      { length: 190 },
      (_, index) => indexLine(index, `中文描述-${'甲'.repeat(60)}`),
    );
    const original = `${lines.join('\n')}\n`;
    expect(Buffer.byteLength(original, 'utf-8')).toBeGreaterThan(25 * 1024);
    writeFileSync(join(memoryDir, 'MEMORY.md'), original, 'utf-8');

    const result = loadMemorySnapshot(memoryDir);

    expect(result.snapshot.isTruncated).toBe(true);
    expect(result.diagnostic.truncation).toEqual({
      reason: 'byte_limit',
      limit: 25 * 1024,
    });
    expect(result.snapshot.content.endsWith('\n')).toBe(true);
    expect(result.snapshot.content).not.toContain('\uFFFD');
    expect(Buffer.byteLength(result.snapshot.content, 'utf-8')).toBeLessThanOrEqual(25 * 1024);
  });

  it('重复引用只保留第一条，非法文件名只进入诊断', () => {
    const content = [
      '- [第一条](same-topic.md) — first',
      '- [重复条](same-topic.md) — duplicate',
      '- [非法](UPPER_CASE.md) — invalid',
    ].join('\n');
    writeFileSync(join(memoryDir, 'MEMORY.md'), content, 'utf-8');

    const result = loadMemorySnapshot(memoryDir);

    expect(result.snapshot.topics).toHaveLength(1);
    expect(result.snapshot.topics[0].title).toBe('第一条');
    expect(result.diagnostic.duplicates).toEqual(['same-topic.md']);
    expect(result.diagnostic.invalidFilenames).toEqual(['UPPER_CASE.md']);
  });

  it('旧格式 topics/ 前缀索引条目不被接受', () => {
    writeFileSync(join(memoryDir, 'MEMORY.md'), '- [旧](topics/foo.md) — desc\n', 'utf-8');

    const result = loadMemorySnapshot(memoryDir);

    expect(result.snapshot.topics).toHaveLength(0);
    // fail-closed：含路径分隔符的条目不进入主题列表，但保留在无效文件名诊断中。
    expect(result.diagnostic.invalidFilenames).toEqual(['topics/foo.md']);
  });

  it('memory.md 为保留名，大小写变体均记为无效文件名', () => {
    writeFileSync(
      join(memoryDir, 'MEMORY.md'),
      [
        '- [保留](memory.md) — desc',
        '- [变体](Memory.md) — desc',
        '- [正常](other.md) — desc',
      ].join('\n'),
      'utf-8',
    );

    const result = loadMemorySnapshot(memoryDir);

    expect(result.snapshot.topics).toHaveLength(1);
    expect(result.snapshot.topics[0].slug).toBe('other');
    expect(result.diagnostic.invalidFilenames).toEqual(['memory.md', 'Memory.md']);
  });

  it('显式诊断同样将保留名 memory.md 记为无效文件名', () => {
    writeFileSync(join(memoryDir, 'MEMORY.md'), '- [保留](memory.md) — desc\n', 'utf-8');

    const explicit = diagnoseMemoryTopics(memoryDir);

    expect(explicit.diagnostic.invalidFilenames).toEqual(['memory.md']);
    expect(explicit.topics).toHaveLength(0);
  });

  it('加载器不修改 MEMORY.md 的磁盘内容', () => {
    const content = `${indexLine(1)}\r\n`;
    writeFileSync(join(memoryDir, 'MEMORY.md'), content, 'utf-8');

    loadMemorySnapshot(memoryDir);

    expect(readFileSync(join(memoryDir, 'MEMORY.md'), 'utf-8')).toBe(content);
  });

  it('只有显式诊断才读取 topic，并报告断链、未知 type 与无效 frontmatter', () => {
    writeFileSync(
      join(memoryDir, 'MEMORY.md'),
      [
        '- [有效](valid.md) — valid',
        '- [未知](unknown.md) — unknown',
        '- [损坏](broken.md) — broken',
        '- [缺失](missing.md) — missing',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(memoryDir, 'valid.md'),
      '---\nname: 有效主题\ndescription: 有效描述\ntype: project\n---\n正文',
      'utf-8',
    );
    writeFileSync(
      join(memoryDir, 'unknown.md'),
      '---\nname: 未知主题\ndescription: 未知描述\ntype: secret\n---\n正文',
      'utf-8',
    );
    writeFileSync(
      join(memoryDir, 'broken.md'),
      '没有 frontmatter',
      'utf-8',
    );

    const startup = loadMemorySnapshot(memoryDir);
    expect(startup.diagnostic).toMatchObject({
      brokenLinks: [],
      unknownTypes: [],
      invalidFrontmatter: [],
    });
    expect(startup.snapshot.topics.every(topic => topic.type === undefined)).toBe(true);

    const explicit = diagnoseMemoryTopics(memoryDir);
    expect(explicit.diagnostic.brokenLinks).toEqual(['missing.md']);
    expect(explicit.diagnostic.unknownTypes).toEqual(['unknown.md']);
    expect(explicit.diagnostic.invalidFrontmatter).toEqual(['broken.md']);
    expect(explicit.topics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        slug: 'valid',
        name: '有效主题',
        type: 'project',
      }),
      expect.objectContaining({
        slug: 'unknown',
        type: undefined,
      }),
    ]));
  });
});
