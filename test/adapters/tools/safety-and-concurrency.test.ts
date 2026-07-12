/**
 * @file safety-and-concurrency.test.ts
 * @description 验证统一本地工具运行时的审批拦截、文件锁与终端中断行为。
 */

import { describe, it, expect, vi } from 'vitest';
import { resolve } from 'path';
import { FileLockManager } from '../../../src/core/usecases/security/FileLockManager.js';
import { buildNativeTools } from '../../../src/adapters/tools/tool-factory.js';
import { ToolCatalog } from '../../../src/adapters/tools/ToolCatalog.js';
import { ToolExecutor } from '../../../src/adapters/tools/ToolExecutor.js';
import { SessionContext } from '../../../src/core/domain/context.js';
import { CompactionService } from '../../../src/core/usecases/brain/CompactionService.js';
import { runCommandEngine } from '../../../src/adapters/tools/impl/system/terminal-engine.js';
import type { ChatMessage } from '../../../src/ports/driven/llm/LlmPort.js';
import type { LlmPort } from '../../../src/ports/driven/llm/LlmPort.js';
import type { ContextRepository } from '../../../src/core/usecases/brain/ContextRepository.js';
import type { ToolRegistryPort } from '../../../src/ports/driven/tools/ToolRegistryPort.js';
import type { AppConfig } from '../../../src/config/index.js';

describe('安全与并发增强特性测试', () => {
  const testWorkspace = process.cwd();

  /** 构建可注册测试工具的统一本地工具运行时。 */
  function createToolRuntime(): { catalog: ToolCatalog; executor: ToolExecutor } {
    const catalog = new ToolCatalog(buildNativeTools());
    return {
      catalog,
      executor: new ToolExecutor(catalog)
    };
  }

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

  describe('2. 高危写操作硬拦截 ( ToolExecutor.execute )', () => {
    it('直接调用 ToolExecutor 必须在权限网关外被拒绝', async () => {
      const runtime = createToolRuntime();
      await expect(runtime.executor.execute(
        'dangerous_custom_tool',
        {}
      )).rejects.toThrow('ToolCallGateway');
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
    it('同步快速命令完成时不应注入 completed notification', async () => {
      const notifications: Array<{ type: string }> = [];

      const result = await runCommandEngine(
        `"${process.execPath}" -e "console.log('sync-ok')"`,
        testWorkspace,
        false,
        {
          timeoutMs: 5000,
          onNotification: (event) => notifications.push(event)
        }
      );

      expect(result).toContain('sync-ok');
      expect(notifications.filter(event => event.type === 'completed')).toHaveLength(0);
    });

    it('后台托管命令完成时应发送 completed notification', async () => {
      const notifications: Array<{ type: string }> = [];

      const result = await runCommandEngine(
        `"${process.execPath}" -e "setTimeout(() => console.log('bg-ok'), 350)"`,
        testWorkspace,
        true,
        {
          timeoutMs: 5000,
          noOutputTimeoutMs: 3000,
          onNotification: (event) => notifications.push(event)
        }
      );

      expect(result).toContain('Task ID');
      await new Promise(resolve => setTimeout(resolve, 900));
      expect(notifications.some(event => event.type === 'completed')).toBe(true);
    });

    it('调用 runCommandEngine 时，如果 signal 被 abort 应当能迅速强杀进程释放', async () => {
      const controller = new AbortController();

      setTimeout(() => {
        controller.abort();
      }, 100);

      const startTime = Date.now();
      const result = await runCommandEngine(
        `"${process.execPath}" -e "setTimeout(() => {}, 10000)"`,
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
