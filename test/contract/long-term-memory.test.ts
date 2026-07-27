/**
 * @fileoverview 长期记忆端到端静态契约测试。
 * 验证 memoryDir 隔离、MEMORY.md + topics/*.md 布局、四种类型、固定容量、
 * 独立请求投影、标准文件工具授权、无专用 memory 工具注册。
 * 同时验证写入顺序与遗忘规则的提示词约束。
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'path';
import { createApplicationPaths } from '../../src/config/application-paths.js';
import { loadMemorySnapshot, type MemoryType } from '../../src/core/usecases/brain/memory-loader.js';
import { LONG_TERM_MEMORY_RULES } from '../../src/core/usecases/brain/prompts.js';
import { buildNativeTools } from '../../src/adapters/tools/tool-factory.js';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('长期记忆静态契约', () => {
  describe('memoryDir 隔离', () => {
    it('memoryDir 位于 projectDataDir 下', () => {
      const paths = createApplicationPaths('/home/user/proj');
      expect(paths.memoryDir).toBe(resolve(paths.projectDataDir, 'memory'));
    });

    it('memoryDir 不在工作区 .myagent 下', () => {
      const paths = createApplicationPaths('/workspace/app');
      expect(paths.memoryDir.startsWith(resolve('/workspace/app/.myagent'))).toBe(false);
    });

    it('不同 workspace-key 的 memoryDir 不同', () => {
      const a = createApplicationPaths('/home/user/proj');
      const b = createApplicationPaths('/tmp/proj');
      expect(a.memoryDir).not.toBe(b.memoryDir);
    });
  });

  describe('MEMORY.md + topics/*.md 布局', () => {
    it('加载器支持 topics 单层目录', () => {
      const dir = join(tmpdir(), `mem-contract-${Date.now()}`);
      mkdirSync(join(dir, 'topics'), { recursive: true });
      writeFileSync(join(dir, 'MEMORY.md'), '- [test](topics/test.md) — desc\n', 'utf-8');
      writeFileSync(join(dir, 'topics', 'test.md'), '---\nname: test\ndescription: desc\ntype: user\n---\n', 'utf-8');

      const { snapshot } = loadMemorySnapshot(dir);
      expect(snapshot.isEmpty).toBe(false);
      expect(snapshot.topics).toHaveLength(1);
      expect(snapshot.topics[0].slug).toBe('test');

      rmSync(dir, { recursive: true, force: true });
    });

    it('无 MEMORY.md 时返回空快照', () => {
      const dir = join(tmpdir(), `mem-contract-empty-${Date.now()}`);
      mkdirSync(dir, { recursive: true });
      const { snapshot } = loadMemorySnapshot(dir);
      expect(snapshot.isEmpty).toBe(true);
      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('四种类型支持', () => {
    const types: MemoryType[] = ['user', 'feedback', 'project', 'reference'];

    for (const type of types) {
      it(`type="${type}" 可通过校验`, () => {
        const dir = join(tmpdir(), `mem-type-${type}-${Date.now()}`);
        mkdirSync(join(dir, 'topics'), { recursive: true });
        writeFileSync(join(dir, 'MEMORY.md'), `- [${type}](topics/${type}.md) — ${type}\n`, 'utf-8');
        writeFileSync(join(dir, 'topics', `${type}.md`), `---\nname: ${type}\ndescription: ${type}\ntype: ${type}\n---\n`, 'utf-8');

        const { snapshot, diagnostic } = loadMemorySnapshot(dir);
        expect(snapshot.isEmpty).toBe(false);
        expect(snapshot.topics[0].type).toBe(type);
        expect(diagnostic.unknownTypes).toHaveLength(0);
        expect(diagnostic.invalidFrontmatter).toHaveLength(0);

        rmSync(dir, { recursive: true, force: true });
      });
    }
  });

  describe('固定容量', () => {
    it('200 行索引不截断', () => {
      const dir = join(tmpdir(), `mem-200-${Date.now()}`);
      mkdirSync(join(dir, 'topics'), { recursive: true });
      for (let i = 0; i < 200; i++) {
        writeFileSync(join(dir, 'topics', `t${i}.md`), `---\nname: t${i}\ndescription: t${i}\ntype: user\n---\n`, 'utf-8');
      }
      const lines = Array.from({ length: 200 }, (_, i) => `- [t${i}](topics/t${i}.md) — desc ${i}`);
      writeFileSync(join(dir, 'MEMORY.md'), lines.join('\n') + '\n', 'utf-8');

      const { snapshot } = loadMemorySnapshot(dir);
      expect(snapshot.isTruncated).toBe(false);
      expect(snapshot.topics).toHaveLength(200);

      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('独立请求投影', () => {
    it('MemorySnapshot 主题包含构造投影所需全部字段', () => {
      const dir = join(tmpdir(), `mem-proj-${Date.now()}`);
      mkdirSync(join(dir, 'topics'), { recursive: true });
      writeFileSync(join(dir, 'MEMORY.md'), '- [偏好](topics/pref.md) — 用户偏好\n', 'utf-8');
      writeFileSync(join(dir, 'topics', 'pref.md'), '---\nname: 偏好\ndescription: 用户编码风格\ntype: user\n---\n', 'utf-8');

      const { snapshot } = loadMemorySnapshot(dir);
      expect(snapshot.topics[0]).toHaveProperty('title');
      expect(snapshot.topics[0]).toHaveProperty('slug');
      expect(snapshot.topics[0]).toHaveProperty('indexDescription');
      expect(snapshot.topics[0]).toHaveProperty('type');

      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('提示词契约：写入与忘记规则', () => {
    it('system prompt 包含四种记忆类型说明', () => {
      expect(LONG_TERM_MEMORY_RULES).toContain('四种记忆类型');
      expect(LONG_TERM_MEMORY_RULES).toContain('`user`');
      expect(LONG_TERM_MEMORY_RULES).toContain('`feedback`');
      expect(LONG_TERM_MEMORY_RULES).toContain('`project`');
      expect(LONG_TERM_MEMORY_RULES).toContain('`reference`');
    });

    it('system prompt 包含不适合保存的内容', () => {
      expect(LONG_TERM_MEMORY_RULES).toContain('不适合保存的内容');
      expect(LONG_TERM_MEMORY_RULES).toContain('秘密');
      expect(LONG_TERM_MEMORY_RULES).toContain('推测');
    });

    it('system prompt 规定先写主题文件再更新索引', () => {
      expect(LONG_TERM_MEMORY_RULES).toContain('必须先写入主题文件');
      expect(LONG_TERM_MEMORY_RULES).toContain('再更新');
    });

    it('system prompt 提供不可省略的 frontmatter 和索引模板', () => {
      expect(LONG_TERM_MEMORY_RULES).toContain('三个字段均不可省略');
      expect(LONG_TERM_MEMORY_RULES).toContain('name: {{清晰、稳定的主题名称}}');
      expect(LONG_TERM_MEMORY_RULES).toContain('description: {{用于未来判断相关性的一行具体描述}}');
      expect(LONG_TERM_MEMORY_RULES).toContain('type: {{user、feedback、project、reference 四选一}}');
      expect(LONG_TERM_MEMORY_RULES).toContain('- [简洁标题](topics/<slug>.md) — 一行相关性摘要');
    });

    it('system prompt 要求写后自检且禁止补充未经确认的事实', () => {
      expect(LONG_TERM_MEMORY_RULES).toContain('不得编造用户没有确认的原因、工具、数字、技术栈或项目细节');
      expect(LONG_TERM_MEMORY_RULES).toContain('必须重新读取结果');
      expect(LONG_TERM_MEMORY_RULES).toContain('frontmatter 完整');
    });

    it('system prompt 规定忘记操作先删除内容再更新索引', () => {
      expect(LONG_TERM_MEMORY_RULES).toContain('忘记单项内容');
      expect(LONG_TERM_MEMORY_RULES).toContain('先删除主题文件');
    });

    it('system prompt 规定不能擦除已有会话历史', () => {
      expect(LONG_TERM_MEMORY_RULES).toContain('不得声称能擦除');
    });

    it('system prompt 规定使用标准文件工具而非专用 memory 工具', () => {
      expect(LONG_TERM_MEMORY_RULES).toContain('标准文件工具');
      expect(LONG_TERM_MEMORY_RULES).toContain('没有专用的 memory 工具');
    });

    it('system prompt 规定普通写入不刷新自动快照', () => {
      expect(LONG_TERM_MEMORY_RULES).toContain('**不会**自动刷新');
    });
  });

  describe('无专用 memory 工具注册', () => {
    it('默认工具列表不包含 "memory" 字样', () => {
      const toolNames = buildNativeTools().map((tool) => tool.name);
      expect(toolNames.some((name) => name.toLowerCase().includes('memory'))).toBe(false);
      expect(toolNames).toEqual(expect.arrayContaining([
        'readFile',
        'writeFile',
        'editFile',
        'listFiles',
        'deletePath',
      ]));
    });

    it('system prompt 声明没有专用 memory 工具', () => {
      const sentences = LONG_TERM_MEMORY_RULES.split('\n');
      const noDedicatedTool = sentences.some(s => s.includes('没有专用的 memory 工具'));
      expect(noDedicatedTool).toBe(true);
    });
  });
});
