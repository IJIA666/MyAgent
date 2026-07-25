/**
 * @fileoverview ToolDispatcher 的单元测试，验证大输出截断和 JIT 伴生规范注入。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ToolDispatcher } from '../../../../src/core/usecases/engine/ToolDispatcher.js';
import { SessionContext } from '../../../../src/core/domain/context.js';
import { AppConfig } from '../../../../src/config/index.js';
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
