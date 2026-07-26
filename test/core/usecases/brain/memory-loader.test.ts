/**
 * @file 长期记忆快照加载器单元测试。
 * 覆盖空目录与缺失索引、200 行边界、20KB 边界、UTF-8 字节截断、磁盘文件不被修改、
 * 有效与无效条目混合、重复索引、断链、非法 slug、未知类型和损坏 frontmatter。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadMemorySnapshot, type MemoryType } from '../../../../src/core/usecases/brain/memory-loader.js';

/** writeTopic 的宽松类型，允许传入非法 type 用于测试。 */
function writeTopicRaw(memoryDir: string, filename: string, name: string, description: string, type: string, body = ''): void {
  const frontmatter = `---
name: ${name}
description: ${description}
type: ${type}
---
${body}`;
  writeFileSync(join(memoryDir, 'topics', filename), frontmatter, 'utf-8');
}

/** 创建临时测试目录并返回路径。 */
function createTempDir(): string {
  const dir = join(tmpdir(), `memory-loader-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 在 memoryDir 下创建 topics/ 目录。 */
function ensureTopicsDir(memoryDir: string): void {
  const topicsDir = join(memoryDir, 'topics');
  mkdirSync(topicsDir, { recursive: true });
}

/** 写入 MEMORY.md。 */
function writeIndex(memoryDir: string, content: string): void {
  writeFileSync(join(memoryDir, 'MEMORY.md'), content, 'utf-8');
}

/** 写入主题文件。 */
function writeTopic(memoryDir: string, filename: string, name: string, description: string, type: MemoryType, body = ''): void {
  const frontmatter = `---
name: ${name}
description: ${description}
type: ${type}
---
${body}`;
  writeFileSync(join(memoryDir, 'topics', filename), frontmatter, 'utf-8');
}

/** 生成指定数量的索引行。 */
function generateIndexLines(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `- [主题 ${i}](topics/topic-${i}.md) — 第 ${i} 个主题的描述`);
}

describe('loadMemorySnapshot', () => {
  let memoryDir: string;

  beforeEach(() => {
    memoryDir = createTempDir();
  });

  afterEach(() => {
    if (existsSync(memoryDir)) {
      rmSync(memoryDir, { recursive: true, force: true });
    }
  });

  // ── 空目录 / 缺失索引 ──
  describe('空目录与缺失索引', () => {
    it('完全空目录返回空快照', () => {
      const { snapshot, diagnostic } = loadMemorySnapshot(memoryDir);
      expect(snapshot.isEmpty).toBe(true);
      expect(snapshot.memoryDir).toBe(memoryDir);
      expect(snapshot.topics).toHaveLength(0);
      expect(snapshot.isTruncated).toBe(false);
      // 诊断应无异常
      expect(diagnostic.truncation).toBeNull();
    });

    it('目录存在但没有 MEMORY.md 返回空快照', () => {
      ensureTopicsDir(memoryDir);
      const { snapshot } = loadMemorySnapshot(memoryDir);
      expect(snapshot.isEmpty).toBe(true);
      expect(snapshot.topics).toHaveLength(0);
    });

    it('MEMORY.md 存在但无有效索引行返回空快照', () => {
      writeIndex(memoryDir, '# 长期记忆\n\n无内容。');
      const { snapshot, diagnostic } = loadMemorySnapshot(memoryDir);
      expect(snapshot.isEmpty).toBe(true);
      expect(snapshot.topics).toHaveLength(0);
      expect(diagnostic.truncation).toBeNull();
    });
  });

  // ── 正常加载 ──
  describe('正常加载', () => {
    it('加载一条有效主题', () => {
      ensureTopicsDir(memoryDir);
      writeTopic(memoryDir, 'user-preference.md', '用户偏好', '用户编码风格偏好', 'user');
      writeIndex(memoryDir, '- [用户偏好](topics/user-preference.md) — 用户的编码风格偏好\n');

      const { snapshot, diagnostic } = loadMemorySnapshot(memoryDir);
      expect(snapshot.isEmpty).toBe(false);
      expect(snapshot.topics).toHaveLength(1);
      expect(snapshot.topics[0]).toMatchObject({
        slug: 'user-preference',
        title: '用户偏好',
        name: '用户偏好',
        type: 'user',
      });
      expect(diagnostic.brokenLinks).toHaveLength(0);
      expect(diagnostic.invalidFilenames).toHaveLength(0);
      expect(diagnostic.invalidFrontmatter).toHaveLength(0);
    });

    it('加载四种类型的主题', () => {
      ensureTopicsDir(memoryDir);
      const types: MemoryType[] = ['user', 'feedback', 'project', 'reference'];
      for (const t of types) {
        writeTopic(memoryDir, `${t}-test.md`, `${t} 主题`, `${t} 描述`, t, `# ${t} 正文`);
      }
      writeIndex(memoryDir, [
        '- [用户](topics/user-test.md) — 用户',
        '- [反馈](topics/feedback-test.md) — 反馈',
        '- [项目](topics/project-test.md) — 项目',
        '- [参考](topics/reference-test.md) — 参考',
      ].join('\n') + '\n');

      const { snapshot } = loadMemorySnapshot(memoryDir);
      expect(snapshot.topics).toHaveLength(4);
      expect(snapshot.topics.map((t) => t.type)).toEqual(expect.arrayContaining(types));
    });
  });

  // ── 200 行边界 ──
  describe('200 行边界', () => {
    it('恰好 200 行不截断', () => {
      ensureTopicsDir(memoryDir);
      // 为前 200 行创建对应主题文件
      for (let i = 0; i < 200; i++) {
        writeTopic(memoryDir, `topic-${i}.md`, `主题 ${i}`, `描述 ${i}`, 'user');
      }
      const lines = generateIndexLines(200);
      writeIndex(memoryDir, lines.join('\n') + '\n');

      const { snapshot, diagnostic } = loadMemorySnapshot(memoryDir);
      expect(snapshot.isTruncated).toBe(false);
      expect(snapshot.topics).toHaveLength(200);
      expect(diagnostic.truncation).toBeNull();
    });

    it('超过 200 行触发行截断', () => {
      ensureTopicsDir(memoryDir);
      // 创建 210 个主题文件（需要多少创建多少，但测试截断只需前 200 个可用）
      for (let i = 0; i < 210; i++) {
        writeTopic(memoryDir, `topic-${i}.md`, `主题 ${i}`, `描述 ${i}`, 'user');
      }
      const lines = generateIndexLines(210);
      writeIndex(memoryDir, lines.join('\n') + '\n');

      const { snapshot, diagnostic } = loadMemorySnapshot(memoryDir);
      expect(snapshot.isTruncated).toBe(true);
      expect(diagnostic.truncation).not.toBeNull();
      expect(diagnostic.truncation!.reason).toBe('line_limit');
      expect(diagnostic.truncation!.limit).toBe(200);
      // 截断后只加载前 200 个
      expect(snapshot.topics).toHaveLength(200);
    });
  });

  // ── 20KB 边界 ──
  describe('20KB 边界', () => {
    it('恰好 20KB 不截断', () => {
      ensureTopicsDir(memoryDir);
      // 构造略低于 20KB 的索引：200 行每行约 96 字节（英文为主避免 UTF-8 膨胀）
      const line = (i: number) =>
        `- [Topic ${String(i).padStart(3, '0')}](topics/topic-${i}.md) — ${'x'.repeat(50)} #${String(i).padStart(3, '0')}`;
      // 验证总字节 < 20KB
      const testContent = Array.from({ length: 200 }, (_, i) => line(i)).join('\n');
      if (Buffer.byteLength(testContent, 'utf-8') >= 20 * 1024) {
        throw new Error(`测试数据超 20KB: ${Buffer.byteLength(testContent, 'utf-8')} bytes`);
      }
      for (let i = 0; i < 200; i++) {
        writeTopic(memoryDir, `topic-${i}.md`, `Topic ${i}`, `Desc ${i}`, 'user');
      }
      writeIndex(memoryDir, testContent + '\n');

      const { snapshot, diagnostic } = loadMemorySnapshot(memoryDir);
      expect(snapshot.isTruncated).toBe(false);
      expect(diagnostic.truncation).toBeNull();
    });

    it('超过 20KB 触发字节截断', () => {
      ensureTopicsDir(memoryDir);
      // 一行约 200 字节，150 行约 30KB，会触发字节截断
      for (let i = 0; i < 150; i++) {
        writeTopic(memoryDir, `topic-${i}.md`, `主题 ${i}`, `描述 ${i}`, 'user');
      }
      const lines = Array.from({ length: 150 }, (_, i) =>
        `- [长度较长的索引标题行 ${String(i).padStart(5, '0')}](topics/topic-${i}.md) — 这是一段较长的描述文本内容用于测试字节截断 ${'x'.repeat(100)}`
      );
      writeIndex(memoryDir, lines.join('\n') + '\n');

      const { snapshot, diagnostic } = loadMemorySnapshot(memoryDir);
      expect(snapshot.isTruncated).toBe(true);
      expect(diagnostic.truncation).not.toBeNull();
      expect(diagnostic.truncation!.reason).toBe('byte_limit');
    });

    it('行边界早于字节边界时必须按 200 行截断', () => {
      ensureTopicsDir(memoryDir);
      for (let i = 0; i < 200; i++) {
        writeTopic(memoryDir, `topic-${i}.md`, `主题 ${i}`, `描述 ${i}`, 'user');
      }
      const lines = generateIndexLines(1000);
      expect(Buffer.byteLength(lines.join('\n'), 'utf-8')).toBeGreaterThan(20 * 1024);
      writeIndex(memoryDir, lines.join('\n') + '\n');

      const { snapshot, diagnostic } = loadMemorySnapshot(memoryDir);
      expect(snapshot.topics).toHaveLength(200);
      expect(diagnostic.truncation).toEqual({ reason: 'line_limit', limit: 200 });
    });
  });

  // ── 磁盘文件不被修改 ──
  describe('磁盘文件不被修改', () => {
    it('加载后 MEMORY.md 内容不变', () => {
      ensureTopicsDir(memoryDir);
      writeTopic(memoryDir, 'test.md', '测试', '测试', 'user');
      const originalIndex = '- [测试](topics/test.md) — 测试\n';
      writeIndex(memoryDir, originalIndex);

      loadMemorySnapshot(memoryDir);
      const afterContent = readFileSync(join(memoryDir, 'MEMORY.md'), 'utf-8');
      expect(afterContent).toBe(originalIndex);
    });

    it('加载后主题文件内容不变', () => {
      ensureTopicsDir(memoryDir);
      writeTopic(memoryDir, 'test.md', '测试', '测试', 'user', '# 原始正文');
      writeIndex(memoryDir, '- [测试](topics/test.md) — 测试\n');

      loadMemorySnapshot(memoryDir);
      const afterTopic = readFileSync(join(memoryDir, 'topics', 'test.md'), 'utf-8');
      expect(afterTopic).toContain('原始正文');
      expect(afterTopic).toContain('type: user');
    });

    it('不存在的目录不创建任何文件', () => {
      const nonExistentDir = join(tmpdir(), `nonexistent-memory-${Date.now()}`);
      const { snapshot } = loadMemorySnapshot(nonExistentDir);
      expect(snapshot.isEmpty).toBe(true);
      expect(existsSync(nonExistentDir)).toBe(false);
    });
  });

  // ── 有效与无效条目混合 ──
  describe('有效与无效条目混合', () => {
    it('有效条目正常加载，无效条目报告诊断', () => {
      ensureTopicsDir(memoryDir);
      // 有效主题
      writeTopic(memoryDir, 'valid.md', '有效', '有效主题', 'user');
      writeTopic(memoryDir, 'project-notes.md', '项目说明', '项目说明', 'project');
      // 有效但文件不存在（断链）
      // 无效文件名格式
      // 未知类型
      writeTopicRaw(memoryDir, 'unknown-type.md', '未知类型', '未知类型', 'custom_type');
      // 无效 frontmatter（缺少 name）
      writeFileSync(join(memoryDir, 'topics', 'no-name.md'), "---\ndescription: 无名称\ntype: user\n---\n", 'utf-8');

      writeIndex(memoryDir, [
        '- [有效](topics/valid.md) — 有效',
        '- [项目说明](topics/project-notes.md) — 项目说明',
        '- [断链](topics/broken.md) — 不存在的文件',
        '- [无效文件名](topics/UPPERCASE.md) — 大写非法',
        '- [未知类型](topics/unknown-type.md) — 未知类型',
        '- [无名称](topics/no-name.md) — 无 frontmatter 名称',
      ].join('\n') + '\n');

      const { snapshot, diagnostic } = loadMemorySnapshot(memoryDir);
      // 有效条目
      expect(snapshot.topics).toHaveLength(2);
      expect(snapshot.topics.map((t) => t.slug)).toEqual(expect.arrayContaining(['valid', 'project-notes']));
      // 诊断
      expect(diagnostic.brokenLinks).toContain('broken.md');
      expect(diagnostic.invalidFilenames).toContain('UPPERCASE.md');
      expect(diagnostic.unknownTypes.some((s) => s.includes('unknown-type'))).toBe(true);
      expect(diagnostic.invalidFrontmatter).toContain('no-name.md');
    });
  });

  // ── 重复索引 ──
  describe('重复索引', () => {
    it('相同文件引用多次报告重复且只保留一次', () => {
      ensureTopicsDir(memoryDir);
      writeTopic(memoryDir, 'duplicate.md', '重复', '重复', 'user');
      writeIndex(memoryDir, [
        '- [第一次](topics/duplicate.md) — 第一次',
        '- [第二次](topics/duplicate.md) — 第二次',
        '- [第三次](topics/duplicate.md) — 第三次',
      ].join('\n') + '\n');

      const { snapshot, diagnostic } = loadMemorySnapshot(memoryDir);
      expect(snapshot.topics).toHaveLength(1);
      expect(snapshot.topics[0].slug).toBe('duplicate');
      // 第一次保留
      expect(diagnostic.duplicates).toContain('duplicate.md');
    });
  });

  // ── 非法 slug ──
  describe('非法 slug 文件名', () => {
    it('文件名不符合 kebab-case 被拒绝', () => {
      ensureTopicsDir(memoryDir);
      writeTopic(memoryDir, 'Topic_Name.md', '非法', '非法', 'user');
      writeTopic(memoryDir, 'topic name.md', '非法空格', '非法空格', 'user');
      writeTopic(memoryDir, 'topic@name.md', '非法字符', '非法字符', 'user');
      writeTopic(memoryDir, 'topic-中文.md', '中文', '中文', 'user');
      writeIndex(memoryDir, [
        '- [非法](topics/Topic_Name.md) — 非法',
        '- [非法空格](topics/topic name.md) — 非法',
        '- [非法字符](topics/topic@name.md) — 非法',
        '- [中文](topics/topic-中文.md) — 中文',
      ].join('\n') + '\n');

      const { snapshot, diagnostic } = loadMemorySnapshot(memoryDir);
      expect(snapshot.topics).toHaveLength(0);
      expect(diagnostic.invalidFilenames).toHaveLength(4);
    });
  });

  // ── 损坏 frontmatter ──
  describe('损坏 frontmatter', () => {
    it('支持 Windows CRLF frontmatter', () => {
      ensureTopicsDir(memoryDir);
      writeFileSync(
        join(memoryDir, 'topics', 'windows-crlf.md'),
        '---\r\nname: Windows\r\ndescription: CRLF frontmatter\r\ntype: project\r\n---\r\n\r\n# 正文\r\n',
        'utf-8',
      );
      writeIndex(memoryDir, '- [Windows](topics/windows-crlf.md) — CRLF\r\n');

      const { snapshot, diagnostic } = loadMemorySnapshot(memoryDir);
      expect(snapshot.topics).toHaveLength(1);
      expect(snapshot.topics[0].type).toBe('project');
      expect(diagnostic.invalidFrontmatter).toHaveLength(0);
    });

    it('完全无 frontmatter', () => {
      ensureTopicsDir(memoryDir);
      writeFileSync(join(memoryDir, 'topics', 'no-fm.md'), '# 无 frontmatter 的正文\n', 'utf-8');
      writeIndex(memoryDir, '- [无 frontmatter](topics/no-fm.md) — 无 frontmatter\n');

      const { snapshot, diagnostic } = loadMemorySnapshot(memoryDir);
      expect(snapshot.topics).toHaveLength(0);
      expect(diagnostic.invalidFrontmatter).toContain('no-fm.md');
    });

    it('frontmatter 缺少 description', () => {
      ensureTopicsDir(memoryDir);
      writeFileSync(join(memoryDir, 'topics', 'no-desc.md'), "---\nname: 无描述\ntype: user\n---\n", 'utf-8');
      writeIndex(memoryDir, '- [无描述](topics/no-desc.md) — 无描述\n');

      const { snapshot, diagnostic } = loadMemorySnapshot(memoryDir);
      expect(snapshot.topics).toHaveLength(0);
      expect(diagnostic.invalidFrontmatter).toContain('no-desc.md');
    });

    it('frontmatter 缺少 type', () => {
      ensureTopicsDir(memoryDir);
      writeFileSync(join(memoryDir, 'topics', 'no-type.md'), "---\nname: 无类型\ndescription: 无类型\n---\n", 'utf-8');
      writeIndex(memoryDir, '- [无类型](topics/no-type.md) — 无类型\n');

      const { snapshot, diagnostic } = loadMemorySnapshot(memoryDir);
      expect(snapshot.topics).toHaveLength(0);
      expect(diagnostic.invalidFrontmatter).toContain('no-type.md');
    });

    it('frontmatter 为空块', () => {
      ensureTopicsDir(memoryDir);
      writeFileSync(join(memoryDir, 'topics', 'empty-fm.md'), "---\n---\n# 正文\n", 'utf-8');
      writeIndex(memoryDir, '- [空 frontmatter](topics/empty-fm.md) — 空\n');

      const { snapshot, diagnostic } = loadMemorySnapshot(memoryDir);
      expect(snapshot.topics).toHaveLength(0);
      expect(diagnostic.invalidFrontmatter).toContain('empty-fm.md');
    });
  });

  // ── 快照不可变性 ──
  describe('快照不可变', () => {
    it('MemorySnapshot 及其内容被冻结', () => {
      ensureTopicsDir(memoryDir);
      writeTopic(memoryDir, 'immutable.md', '不可变', '不可变测试', 'user');
      writeIndex(memoryDir, '- [不可变](topics/immutable.md) — 不可变\n');

      const { snapshot } = loadMemorySnapshot(memoryDir);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.topics)).toBe(true);
      if (snapshot.topics.length > 0) {
        expect(Object.isFrozen(snapshot.topics[0])).toBe(true);
      }
    });
  });

  describe('加载状态', () => {
    it('合法缺失索引返回 empty，读取异常返回 failed', () => {
      const emptyResult = loadMemorySnapshot(memoryDir);
      expect(emptyResult.status).toBe('empty');

      mkdirSync(join(memoryDir, 'MEMORY.md'));
      const failedResult = loadMemorySnapshot(memoryDir);
      expect(failedResult.status).toBe('failed');
      expect(failedResult.diagnostic.warnings[0]).toContain('读取 MEMORY.md 失败');
    });
  });
});
