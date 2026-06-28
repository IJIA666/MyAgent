/**
 * @fileoverview ToolDispatcher 的单元测试，验证大输出截断和 JIT 伴生规范注入。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ToolDispatcher } from '../../src/core/usecases/engine/ToolDispatcher.js';
import { SessionContext } from '../../src/core/domain/context.js';
import { AppConfig } from '../../src/config/index.js';

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
    dispatcher = new ToolDispatcher(context, tempDir);
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('handleLargeToolOutput', () => {
    it('should return original output if length <= limit', () => {
      const output = 'short output';
      const result = dispatcher.handleLargeToolOutput('testTool', output);
      expect(result).toBe(output);
    });

    it('should intercept and dump output to a temp file if length > limit', () => {
      const header = 'START_OF_LARGE_TEXT_';
      const footer = '_END_OF_LARGE_TEXT';
      const middle = 'X'.repeat(2000);
      const longOutput = header + middle + footer;

      const result = dispatcher.handleLargeToolOutput('testTool', longOutput);
      
      expect(result).toContain('警告：工具 "testTool" 的输出内容过长');
      expect(result).toContain('[临时文件路径：.myagent/temp/output_');
      expect(result).toContain('readFile');

      const tempPath = path.join(tempDir, '.myagent/temp');
      expect(fs.existsSync(tempPath)).toBe(true);
      const files = fs.readdirSync(tempPath);
      expect(files.length).toBe(1);
      
      const fileContent = fs.readFileSync(path.join(tempPath, files[0]), 'utf-8');
      expect(fileContent).toBe(longOutput);
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
