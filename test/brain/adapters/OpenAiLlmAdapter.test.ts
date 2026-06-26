/**
 * @file OpenAiLlmAdapter 单元测试。
 * 测试局部并发隔离、级联取消与全局 abort() 广播等核心逻辑。
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { OpenAiLlmAdapter } from '../../../src/adapters/llm/OpenAiLlmAdapter.js';
import type { LlmConfig } from '../../../src/config/index.js';

// Mock openai 库
const mockCreate = vi.fn().mockImplementation((payload: unknown, options: unknown) => {
  const opts = options as { signal?: AbortSignal } | undefined;
  return new Promise((resolve, reject) => {
    if (opts?.signal?.aborted) {
      reject(new Error('AbortError'));
      return;
    }
    const onAbort = () => {
      reject(new Error('AbortError'));
    };
    opts?.signal?.addEventListener('abort', onAbort);
  });
});

vi.mock('openai', () => {
  return {
    OpenAI: class {
      chat = {
        completions: {
          create: mockCreate
        }
      };
    }
  };
});

describe('OpenAiLlmAdapter 单元测试', () => {
  let config: LlmConfig;

  beforeEach(() => {
    config = {
      apiKey: 'test-api-key',
      baseUrl: 'http://localhost:3000',
      model: 'test-model',
      maxTokens: 100,
      profile: {
        id: 'test',
        envKeyName: 'TEST_API_KEY',
        defaultBaseUrl: 'http://localhost:3000',
        defaultModel: 'test-model',
        contextWindow: 1000,
        buildExtraPayload: () => ({})
      }
    };
  });

  test('测试局部并发隔离与外部取消信号级联', async () => {
    const adapter = new OpenAiLlmAdapter(config);
    const externalAC = new AbortController();

    const promise = adapter.chat([{ role: 'user', content: 'hello' }], { signal: externalAC.signal });

    // 延迟 10ms 之后取消外部 controller
    setTimeout(() => {
      externalAC.abort();
    }, 10);

    // 应该因为外部 abort 而抛出 AbortError
    await expect(promise).rejects.toThrow('AbortError');
  });

  test('测试全局 abort() 广播', async () => {
    const adapter = new OpenAiLlmAdapter(config);

    const promise1 = adapter.chat([{ role: 'user', content: 'request 1' }]);
    const promise2 = adapter.chat([{ role: 'user', content: 'request 2' }]);

    // 延迟 10ms 调用全局 abort()
    setTimeout(() => {
      adapter.abort();
    }, 10);

    // 两个并发请求都应当由于全局 abort 被取消并抛出 AbortError
    await expect(promise1).rejects.toThrow('AbortError');
    await expect(promise2).rejects.toThrow('AbortError');
  });
});
