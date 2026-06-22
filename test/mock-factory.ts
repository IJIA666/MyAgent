import type { AppConfig } from '../src/config/types.js';

/**
 * 单元测试专用的 Mock AppConfig 工厂辅助函数。
 * 默认绑定全局 setup 测试沙箱目录，避免物理开发区被污染。
 *
 * @param custom - 自定义覆盖的配置项
 * @returns 完整的 AppConfig 配置对象
 */
export function createMockAppConfig(custom?: Partial<AppConfig>): AppConfig {
  return {
    llm: {
      model: 'mock-model',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'mock-key',
      contextWindow: 100000,
      temperature: 0.7,
      maxTokens: 2000,
      profile: {
        id: 'mock-model-profile',
        envKeyName: 'MOCK_API_KEY',
        defaultBaseUrl: 'https://api.openai.com/v1',
        defaultModel: 'mock-model',
      },
    },
    /* eslint-disable-next-line n/no-process-env */
    workspace: process.env.AUTHORIZED_WORKSPACE_DIR || process.cwd(),
    mcp: {
      mcpServers: {},
    },
    workMode: 'Auto',
    runtimeLimits: {
      maxIterations: 20,
      largeToolOutputLimit: 8000,
      readManyFilesLimit: 50000,
      searchLimit: 100,
      compactionWatermarkFactor: 0.8,
    },
    ...custom,
  };
}
