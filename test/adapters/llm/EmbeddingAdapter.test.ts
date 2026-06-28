import { describe, test, expect, vi } from 'vitest';
import { OpenAiEmbeddingAdapter } from '../../../src/adapters/llm/OpenAiEmbeddingAdapter.js';
import { DashScopeEmbeddingAdapter } from '../../../src/adapters/llm/DashScopeEmbeddingAdapter.js';

describe('Embedding Adapters 物理层与拆批单元测试', () => {
  test('1. OpenAiEmbeddingAdapter 应能执行纯粹的大批量直接透传，无分片切割', async () => {
    const adapter = new OpenAiEmbeddingAdapter({
      model: 'text-embedding-ada-002',
      apiKey: 'mock-key',
      baseUrl: 'https://api.openai.com/v1'
    });

    const mockCreate = vi.fn().mockResolvedValue({
      data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }]
    });
    const adapterWithMock = adapter as unknown as {
      client: {
        embeddings: {
          create: ReturnType<typeof vi.fn>
        }
      }
    };
    adapterWithMock.client = {
      embeddings: {
        create: mockCreate
      }
    };

    const inputs = ['hello', 'world'];
    const result = await adapter.generateEmbeddings(inputs);

    expect(result).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith({
      model: 'text-embedding-ada-002',
      input: inputs
    });
  });

  test('2. DashScopeEmbeddingAdapter 应能正确对大批量请求执行大小为 10 的并发度限制拆批', async () => {
    const adapter = new DashScopeEmbeddingAdapter({
      model: 'text-embedding-v3',
      apiKey: 'mock-key',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    });

    const mockCreate = vi.fn().mockImplementation(async (args: { input: string[] }) => {
      const inputs = args.input;
      return {
        data: inputs.map((_, idx) => ({
          embedding: [idx, idx + 1]
        }))
      };
    });

    const adapterWithMock = adapter as unknown as {
      client: {
        embeddings: {
          create: ReturnType<typeof vi.fn>
        }
      }
    };
    adapterWithMock.client = {
      embeddings: {
        create: mockCreate
      }
    };

    // 构造一个长度为 25 的 input texts 数组，理论上应被切分为 3 个批次（10, 10, 5）发送
    const inputs = Array.from({ length: 25 }, (_, i) => `text-${i}`);
    const result = await adapter.generateEmbeddings(inputs);

    expect(result.length).toBe(25);
    // 验证确实调用了 3 次底层的 create 接口
    expect(mockCreate).toHaveBeenCalledTimes(3);

    // 验证各批次的结果在并发池乱序下依然能被平铺且序号对齐
    expect(result[0]).toEqual([0, 1]);
    expect(result[9]).toEqual([9, 10]);
    expect(result[10]).toEqual([0, 1]); // 第二批的第一个
    expect(result[19]).toEqual([9, 10]); // 第二批的最后一个
    expect(result[20]).toEqual([0, 1]); // 第三批的第一个
    expect(result[24]).toEqual([4, 5]); // 第三批的最后一个
  });
});
