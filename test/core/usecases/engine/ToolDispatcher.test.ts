/**
 * @fileoverview ToolDispatcher 的单元测试，验证大输出截断、声明配额保留和 JIT 伴生规范注入。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  serializeNativeToolTextResultForModel,
  ToolDispatcher,
} from '../../../../src/core/usecases/engine/ToolDispatcher.js';
import { SessionContext } from '../../../../src/core/domain/context.js';
import { AppConfig } from '../../../../src/config/index.js';
import { ToolCatalog } from '../../../../src/adapters/tools/ToolCatalog.js';
import { SkillsListTool } from '../../../../src/adapters/tools/impl/skill/skills-list.js';
import { SkillLibrary } from '../../../../src/core/usecases/brain/skill-library.js';
import { SkillUsageStore } from '../../../../src/core/usecases/brain/skill-usage-store.js';
import type { ToolRegistryPort } from '../../../../src/ports/driven/tools/ToolRegistryPort.js';

describe('ToolDispatcher', () => {
  let context: SessionContext;
  let tempDir: string;
  let dispatcher: ToolDispatcher;

  beforeEach(() => {
    context = new SessionContext('test-tool-session');
    context.appConfig = {
      runtimeLimits: {
        largeToolOutputLimit: 100,
        maxTurns: 10,
        maxContextTokens: 10000,
        compactionThreshold: 8000
      }
    } as unknown as AppConfig;
    
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tool-test-'));

    // Mock 工具注册表，支持去中心化配额声明
    const mockToolRegistry = {
      getTool: (name: string) => {
        if (name === 'customQuotaTool') {
          return {
            name: 'customQuotaTool',
            securityCategory: 'read',
            maxLines: 4,
            maxBytes: 100
          };
        }
        return undefined;
      }
    } as unknown as ToolRegistryPort;

    dispatcher = new ToolDispatcher(context, mockToolRegistry, tempDir, tempDir);
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('handleLargeToolOutput', () => {
    it('should return original output if within quotas (default quotas)', () => {
      const output = 'short output line 1\nline 2';
      const result = dispatcher.handleLargeToolOutput('testTool', output);
      expect(result.isTruncated).toBe(false);
      expect(result.content).toBe(output);
      expect(result.originalPath).toBeUndefined();
    });

    it('should intercept, fold, and dump output to a temp file if exceeding default quotas', () => {
      // 默认配额：maxLines = 2000, maxBytes = 50KB
      // 我们模拟超大行数输出
      const lines: string[] = [];
      for (let i = 1; i <= 3000; i++) {
        lines.push(`Line content ${i}`);
      }
      const longOutput = lines.join('\n');

      const result = dispatcher.handleLargeToolOutput('testTool', longOutput);
      
      expect(result.isTruncated).toBe(true);
      expect(result.content).toContain('警告：工具 "testTool" 的输出内容已超标');
      expect(result.content).toContain('[以下为对折截断后的预览]');
      expect(result.originalPath).toContain('tool_');
      expect(result.originalPath).toContain(tempDir);

      const files = fs.readdirSync(tempDir);
      const logFiles = files.filter(f => f.startsWith('tool_') && f.endsWith('.log'));
      expect(logFiles.length).toBe(1);

      const fileContent = fs.readFileSync(path.join(tempDir, logFiles[0]), 'utf-8');
      expect(fileContent).toBe(longOutput);
    });

    it('should apply custom tool metadata quotas for lines and bytes', () => {
      // customQuotaTool 限额：maxLines = 4, maxBytes = 100
      const output = 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6';
      const result = dispatcher.handleLargeToolOutput('customQuotaTool', output);

      expect(result.isTruncated).toBe(true);
      expect(result.content).toContain('警告：工具 "customQuotaTool" 的输出内容已超标');
      // 验证双向行折叠：取前 2 行和后 2 行拼接
      expect(result.content).toContain('line 1\nline 2');
      expect(result.content).toContain('line 5\nline 6');
    });

    it('should fallback to byte-based truncation if line folding is still too large', () => {
      // customQuotaTool 限额：maxLines = 4, maxBytes = 100
      // 每一单行内容字节数都很大，致使前2行+后2行依旧超出 100 字节
      const longLine = 'Z'.repeat(150);
      const output = `${longLine}\nline 2\nline 3\nline 4\nline 5\n${longLine}`;
      const result = dispatcher.handleLargeToolOutput('customQuotaTool', output);

      expect(result.isTruncated).toBe(true);
      expect(result.content).toContain('[... output truncated ...]');
      // 验证字节折叠：首尾字节各占 50 字节
      const previewText = result.content.split('[以下为对折截断后的预览]：\n')[1];
      const previewParts = previewText.split('\n\n[... output truncated ...]\n\n');
      expect(Buffer.byteLength(previewParts[0], 'utf-8')).toBeLessThanOrEqual(50);
      expect(Buffer.byteLength(previewParts[1], 'utf-8')).toBeLessThanOrEqual(50);
    });

    it('保留 skills_list 声明配额：超过默认 50KB 的目录结果原样透传且不产生恢复文件', async () => {
      // 真实 SkillLibrary：120 个 500 字符描述的 Skill → 目录包络超过统一默认 50KB，
      // 但低于 SkillsListTool 声明的 256KB 配额，且在其自限的 240KB 预算内。
      const userSkills = path.join(tempDir, 'user-skills');
      fs.mkdirSync(userSkills, { recursive: true });
      const usageStore = new SkillUsageStore(path.join(userSkills, '.usage.json'));
      const library = new SkillLibrary(
        userSkills,
        path.join(tempDir, 'project-skills'),
        path.join(userSkills, '.archive'),
        usageStore,
        { enableWatcher: false },
      );
      for (let i = 0; i < 120; i++) {
        const dir = path.join(userSkills, `bulk-${String(i).padStart(3, '0')}`);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'SKILL.md'),
          `---\nname: bulk-${String(i).padStart(3, '0')}\ndescription: ${'描'.repeat(500)}\n---\n\n正文\n`,
          'utf8',
        );
      }
      // 构造后再写入磁盘：显式刷新合并视图，否则目录工具看不到新包。
      library.reloadSkills();

      const listTool = new SkillsListTool(library);
      const raw = await listTool.execute({});
      const modelOutput = serializeNativeToolTextResultForModel(raw);

      // 按生产路径的 CallToolResult 包装与二次序列化后仍超过默认 50KB，
      // 但低于目录工具的内部目标预算和声明配额。
      expect(Buffer.byteLength(modelOutput, 'utf8')).toBeGreaterThan(50 * 1024);
      expect(Buffer.byteLength(modelOutput, 'utf8')).toBeLessThanOrEqual(240 * 1024);

      const catalog = new ToolCatalog([listTool]);
      // ToolCatalog 保留工具声明的配额元数据，供输出层按工具级配额判断。
      expect(catalog.getTool('skills_list')?.maxBytes).toBe(256 * 1024);

      // ToolCatalog 只实现只读查询部分，用包装补齐 ToolRegistryPort 的其余方法。
      const quotaRegistry = {
        getTool: (name: string) => catalog.getTool(name) ?? undefined,
        callTool: vi.fn(),
        close: vi.fn(),
      } as unknown as ToolRegistryPort;
      const quotaDispatcher = new ToolDispatcher(context, quotaRegistry, tempDir, tempDir);
      const result = quotaDispatcher.handleLargeToolOutput('skills_list', modelOutput);
      // 未触发通用折叠：原样透传、无恢复文件、无折叠提示。
      expect(result.isTruncated).toBe(false);
      expect(result.content).toBe(modelOutput);
      expect(result.originalPath).toBeUndefined();
      // 最终模型回执与内层目录均可解析。
      const envelope = JSON.parse(result.content) as { content: Array<{ text: string }> };
      const parsed = JSON.parse(envelope.content[0].text) as {
        complete: boolean;
        totalCount: number;
      };
      expect(parsed.totalCount).toBe(120);
      expect(parsed.complete).toBe(true);
      const logFiles = fs.readdirSync(tempDir)
        .filter(f => f.startsWith('tool_') && f.endsWith('.log'));
      expect(logFiles).toHaveLength(0);
    });
  });

  describe('resolveJitContext', () => {
    it('should recursively find and inject README.md or .rules for target path', () => {
      fs.writeFileSync(path.join(tempDir, 'README.md'), 'Root Rules', 'utf-8');
      
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(path.join(srcDir, 'README.md'), 'Src Rules', 'utf-8');

      const compDir = path.join(srcDir, 'components');
      fs.mkdirSync(compDir);
      fs.writeFileSync(path.join(compDir, '.rules'), 'Components Rules', 'utf-8');

      const buttonDir = path.join(compDir, 'button');
      fs.mkdirSync(buttonDir);

      const injectedPaths = new Set<string>();

      const result1 = dispatcher.resolveJitContext('src/components/button/button.ts', injectedPaths);
      expect(result1).toContain('[JIT 规则已加载: src/components/.rules]');
      expect(result1).toContain('Components Rules');
      expect(injectedPaths.has('src/components/.rules')).toBe(true);

      const result2 = dispatcher.resolveJitContext('src/components/button/button.ts', injectedPaths);
      expect(result2).toBe('');

      context.addMessage({
        role: 'system',
        content: 'System prompt [JIT 规则已加载: src/README.md]'
      });

      const newInjected = new Set<string>();
      const result3 = dispatcher.resolveJitContext('src/button.ts', newInjected);
      expect(result3).toBe('');
    });
  });
});
