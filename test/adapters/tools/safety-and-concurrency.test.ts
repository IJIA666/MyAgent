import { describe, it, expect, vi } from 'vitest';
import { resolve } from 'path';
import { FileLockManager } from '../../../src/core/usecases/security/FileLockManager.js';
import { LocalFileSystemMcpServer, NativeTool } from '../../../src/adapters/tools/virtual-mcp.js';
import { SessionContext } from '../../../src/core/domain/context.js';
import { CompactionService } from '../../../src/core/usecases/brain/CompactionService.js';
import { runCommandEngine } from '../../../src/adapters/tools/impl/system/terminal-engine.js';
import type { ChatMessage } from '../../../src/ports/driven/llm/LlmPort.js';
import type { LlmPort } from '../../../src/ports/driven/llm/LlmPort.js';
import type { ContextRepository } from '../../../src/core/usecases/brain/ContextRepository.js';
import type { ToolRegistryPort } from '../../../src/ports/driven/tools/ToolRegistryPort.js';
import type { AppConfig } from '../../../src/config/index.js';

describe('安全与并发增强特性测试', () => {
  const testWorkspace = resolve('d:\\Projects\\MyAgent');

  describe('1. 元数据追踪收集 ( collectRecentFileOperations )', () => {
    it('应根据工具声明的 filePathParamKey 提取物理相对路径，并支持启发式提取', () => {
      const context = new SessionContext('test-compaction');
      context.appConfig = { workspace: testWorkspace } as unknown as AppConfig;

      const mockLlm = {} as unknown as LlmPort;
      const mockRepo = {} as unknown as ContextRepository;

      const mockRegistry = {
        getTool: vi.fn((name) => {
          if (name === 'readFile') {
            return { name: 'readFile', securityCategory: 'read', filePathParamKey: 'targetPath' };
          }
          return undefined;
        })
      } as unknown as ToolRegistryPort;

      const compaction = new CompactionService(context, mockLlm, mockRepo, mockRegistry);

      const messages: ChatMessage[] = [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: {
                name: 'readFile',
                arguments: JSON.stringify({ targetPath: 'src/main.ts' })
              }
            },
            {
              id: 'c2',
              type: 'function',
              function: {
                name: 'unknown_tool',
                arguments: JSON.stringify({ filePath: 'src/utils.ts' })
              }
            }
          ]
        }
      ];

      const collected = compaction.collectRecentFileOperations(messages);
      expect(collected).toContainEqual({ filePath: 'src/main.ts', opType: 'read' });
      expect(collected).toContainEqual({ filePath: 'src/utils.ts', opType: 'read' });
    });
  });

  describe('2. 高危写操作硬拦截 ( LocalFileSystemMcpServer.callTool )', () => {
    it('对未定义元数据且非 read 的工具以降级防御态度执行 waitApproval 拦截', async () => {
      const mcpServer = new LocalFileSystemMcpServer();
      const sessionContext = new SessionContext('test-safety-intercept');
      sessionContext.approvalService.setBypassMode(false);

      const handler = vi.fn((id) => {
        setTimeout(() => {
          sessionContext.approvalService.resolve(id, { action: 'deny' });
        }, 0);
      });
      sessionContext.approvalService.registerApprovalHandler(handler);

      const mockTool = {
        name: 'dangerous_custom_tool',
        definition: {
          name: 'dangerous_custom_tool',
          description: 'A tool without metadata'
        },
        execute: vi.fn().mockResolvedValue('success'),
        checkSafety: vi.fn().mockReturnValue({ status: 'pass' })
      } as unknown as NativeTool;
      mcpServer.register(mockTool);

      const callResult = await mcpServer.callTool({
        name: 'dangerous_custom_tool',
        arguments: {}
      }, sessionContext);

      expect(handler).toHaveBeenCalled();
      expect(callResult.isError).toBe(true);
      expect(callResult.content[0].text).toContain('用户拒绝了高危操作');
    });
  });

  describe('3. 并发冲突锁机制 ( FileLockManager )', () => {
    it('对同一文件发生写写竞态冲突时，能够串行锁定排队', async () => {
      const lockManager = FileLockManager.getInstance();
      const testPath = resolve(testWorkspace, 'temp_concurrency.txt');

      const order: string[] = [];

      const task1 = async () => {
        const release = await lockManager.acquireLock(testPath, 'write');
        order.push('task1-start');
        await new Promise(resolve => setTimeout(resolve, 100));
        order.push('task1-end');
        release();
      };

      const task2 = async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        const release = await lockManager.acquireLock(testPath, 'write');
        order.push('task2-start');
        release();
      };

      await Promise.all([task1(), task2()]);

      expect(order).toEqual(['task1-start', 'task1-end', 'task2-start']);
    });

    it('对同一文件并发读取时，读锁共享，应能够完全并行', async () => {
      const lockManager = FileLockManager.getInstance();
      const testPath = resolve(testWorkspace, 'temp_concurrency_read.txt');

      const order: string[] = [];

      const task1 = async () => {
        const release = await lockManager.acquireLock(testPath, 'read');
        order.push('task1-start');
        await new Promise(resolve => setTimeout(resolve, 50));
        order.push('task1-end');
        release();
      };

      const task2 = async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        const release = await lockManager.acquireLock(testPath, 'read');
        order.push('task2-start');
        release();
      };

      await Promise.all([task1(), task2()]);

      expect(order).toEqual(['task1-start', 'task2-start', 'task1-end']);
    });
  });

  describe('4. 工具执行超时 Abort 物理强杀', () => {
    it('调用 runCommandEngine 时，如果 signal 被 abort 应当能迅速强杀进程释放', async () => {
      const controller = new AbortController();

      setTimeout(() => {
        controller.abort();
      }, 100);

      const startTime = Date.now();
      const result = await runCommandEngine(
        'node -e "setTimeout(() => {}, 10000)"',
        testWorkspace,
        false,
        {
          timeoutMs: 5000,
          signal: controller.signal
        }
      );

      const duration = Date.now() - startTime;
      expect(result).toContain('命令执行超时');
      expect(duration).toBeLessThan(2500); 
    });
  });
});
