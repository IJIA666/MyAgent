import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MemoryService } from '../../src/core/usecases/MemoryService.js';
import { AppConfig, LlmConfig } from '../../src/config/index.js';
import type { VectorDbPort } from '../../src/ports/driven/VectorDbPort.js';
import type { EmbeddingPort } from '../../src/ports/driven/EmbeddingPort.js';
import type { LlmPort, ChatMessage, LlmStreamEvent } from '../../src/ports/driven/LlmPort.js';
import type { ContextAdapter } from '../../src/ports/driven/ContextAdapter.js';
import { createMockAppConfig } from '../mock-factory.js';

describe('MemoryService 单元测试', () => {
  let tempDir: string;
  let appConfig: AppConfig;
  let mockVectorDb: VectorDbPort;
  let mockEmbedding: EmbeddingPort;
  let mockDriver: LlmPort;
  let mockContextAdapter: ContextAdapter;

  beforeEach(() => {
    // 建立临时测试目录，防脏物理写入
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-service-test-'));
    appConfig = createMockAppConfig({
      workspace: tempDir
    });

    mockVectorDb = {
      add: vi.fn().mockResolvedValue(undefined),
      search: vi.fn().mockResolvedValue([]),
      clear: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      count: vi.fn().mockResolvedValue(0)
    } as unknown as VectorDbPort;

    mockEmbedding = {
      generateEmbedding: vi.fn().mockResolvedValue(new Array(1536).fill(0.1)),
      generateEmbeddings: vi.fn().mockImplementation(async (texts: string[]) => {
        return texts.map(() => new Array(1536).fill(0.1));
      })
    } as unknown as EmbeddingPort;

    let streamCalledTimes = 0;
    mockDriver = {
      getModelName: () => 'MockLlm',
      switchModel: vi.fn(),
      abort: vi.fn(),
      streamChat: async function* () {
        streamCalledTimes++;
        // 第一次请求返回工具调用，指示子智能体写入长期记忆
        if (streamCalledTimes === 1) {
          yield {
            type: 'tool_calls',
            toolCalls: [
              {
                id: 'call-1',
                type: 'function',
                function: {
                  name: 'writeMemoryFile',
                  arguments: JSON.stringify({ content: '- **自省结果**：自测试中的提炼信息' })
                }
              }
            ],
            assistantMessage: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: {
                    name: 'writeMemoryFile',
                    arguments: JSON.stringify({ content: '- **自省结果**：自测试中的提炼信息' })
                  }
                }
              ]
            }
          };
        } else {
          // 第二次请求返回完成事件以退出 ReAct 循环
          yield {
            type: 'complete',
            content: '提炼完成。',
            assistantMessage: {
              role: 'assistant',
              content: '提炼完成。'
            }
          };
        }
      }
    } as unknown as LlmPort;

    mockContextAdapter = {
      assemble: (baseHistory: ChatMessage[]) => baseHistory
    } as unknown as ContextAdapter;
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  describe('chunkMemoryText', () => {
    it('应该仅将以 - ** 开头的行提取为独立要点，过滤普通杂乱文本', () => {
      const service = new MemoryService(mockVectorDb, mockEmbedding, appConfig, mockDriver, mockContextAdapter);
      const text = `
# 记忆文件
- **开发偏好**：用户推荐使用 HSL 调色体系。
这是一行普通的说明文字
- **工程规范**：新增代码必须附带 JSDoc。
      `;
      const chunks = service.chunkMemoryText(text);
      expect(chunks).toEqual([
        '- **开发偏好**：用户推荐使用 HSL 调色体系。',
        '- **工程规范**：新增代码必须附带 JSDoc。'
      ]);
    });

    it('如果输入为空则返回空数组', () => {
      const service = new MemoryService(mockVectorDb, mockEmbedding, appConfig, mockDriver, mockContextAdapter);
      expect(service.chunkMemoryText('')).toEqual([]);
    });
  });

  describe('rebuildVectorDbIfEmpty', () => {
    it('当向量库非空时，即使记忆文件存在也不做重建', async () => {
      vi.mocked(mockVectorDb.count).mockResolvedValue(5);
      const service = new MemoryService(mockVectorDb, mockEmbedding, appConfig, mockDriver, mockContextAdapter);
      
      const memoryDir = path.join(tempDir, '.agent');
      fs.mkdirSync(memoryDir, { recursive: true });
      fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), '- **偏好**：信息测试', 'utf-8');

      await service.rebuildVectorDbIfEmpty();
      expect(mockVectorDb.add).not.toHaveBeenCalled();
    });

    it('当数据库为空且记忆文件存在时，应正常重建向量库', async () => {
      vi.mocked(mockVectorDb.count).mockResolvedValue(0);
      const service = new MemoryService(mockVectorDb, mockEmbedding, appConfig, mockDriver, mockContextAdapter);
      
      const memoryDir = path.join(tempDir, '.agent');
      fs.mkdirSync(memoryDir, { recursive: true });
      fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), '- **偏好**：重建验证', 'utf-8');

      await service.rebuildVectorDbIfEmpty();
      expect(mockVectorDb.add).toHaveBeenCalled();
    });
  });

  describe('queueWrite', () => {
    it('写入应该能物理落盘并触发向量同步', async () => {
      const service = new MemoryService(mockVectorDb, mockEmbedding, appConfig, mockDriver, mockContextAdapter);
      const textToWrite = '\n\n- **开发偏好**：使用 TypeScript 5 规范。\n';
      
      await service.queueWrite(textToWrite);

      const filePath = service.getMemoryFilePath();
      expect(fs.existsSync(filePath)).toBe(true);
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      expect(fileContent).toContain('- **开发偏好**：使用 TypeScript 5 规范。');

      // 同步向量库 add 方法应当被调用
      expect(mockVectorDb.add).toHaveBeenCalled();
    });
  });

  describe('triggerMemoryRefinementAsync', () => {
    it('应该成功异步启动隔离的子智能体进行记忆自省提炼', async () => {
      const service = new MemoryService(mockVectorDb, mockEmbedding, appConfig, mockDriver, mockContextAdapter);
      const mockLlmConfig = { model: 'mock-model' } as unknown as LlmConfig;
      
      const history: ChatMessage[] = [
        { role: 'user', content: '我想用 HSL 配色方案做界面。' },
        { role: 'assistant', content: '没问题，推荐使用 HSL 调色体系。' }
      ];

      await service.triggerMemoryRefinementAsync(history, mockLlmConfig);

      // 自省完成后应该写入长期记忆物理文件并触发向量化同步 add
      const filePath = service.getMemoryFilePath();
      expect(fs.existsSync(filePath)).toBe(true);
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('- **自省结果**：自测试中的提炼信息');
      expect(mockVectorDb.add).toHaveBeenCalled();
    });
  });

  describe('triggerMemoryRefinementAsync 超时强杀与降级', () => {
    it('当自省子智能体卡死超时，应当被 Abort 终止并不影响主流程运行', async () => {
      // 1. 设置极短的 subAgentTimeoutMs 以方便触发超时
      appConfig.runtimeLimits = {
        maxIterations: 20,
        largeToolOutputLimit: 1000,
        readManyFilesLimit: 10,
        searchLimit: 100,
        compactionWatermarkFactor: 0.8,
        ragEnabled: true,
        ragScoreThreshold: 0.5,
        ragRecallLimit: 5,
        ragRefinementThreshold: 2,
        loopPreventionLimit: 5,
        compactionRetainCount: 4,
        compactionTriggerDelta: 1000,
        compactionFailureLimit: 3,
        compactionRecentFilesLimit: 5,
        toolTimeoutMs: 1000,
        subAgentTimeoutMs: 50 // 仅有 50 毫秒超时
      };

      // 2. 模拟一个永远挂起（不返回 chunk）的模型流式接口，直到超时 Abort
      const longPendingDriver = {
        getModelName: () => 'MockLlm',
        switchModel: vi.fn(),
        abort: vi.fn(),
        streamChat: async function* (
          messages: unknown,
          tools: unknown,
          options: { signal?: AbortSignal } | unknown
        ) {
          const opts = options as { signal?: AbortSignal };
          const dummy = false;
          if (dummy) {
            yield {} as unknown as LlmStreamEvent;
          }
          // 等待外部信号取消
          await new Promise<void>((resolve, reject) => {
            if (opts?.signal?.aborted) {
              reject(new Error('AbortError'));
              return;
            }
            opts?.signal?.addEventListener('abort', () => reject(new Error('AbortError')));
          });
        }
      } as unknown as LlmPort;

      const service = new MemoryService(mockVectorDb, mockEmbedding, appConfig, longPendingDriver, mockContextAdapter);
      const mockLlmConfig = { model: 'mock-model' } as unknown as LlmConfig;
      const history: ChatMessage[] = [
        { role: 'user', content: 'hello' }
      ];

      // 3. 执行 triggerMemoryRefinementAsync，即使它内部超时，也不应该对外抛出错误崩溃，而是优雅地静默降级（通过 catch 拦截）
      await expect(service.triggerMemoryRefinementAsync(history, mockLlmConfig)).resolves.not.toThrow();

      // 验证未写入文件
      const filePath = service.getMemoryFilePath();
      expect(fs.existsSync(filePath)).toBe(false);
    });
  });
});
