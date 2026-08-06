import { resolve } from 'path';
import { createApplicationPaths } from '../../src/config/application-paths.js';
import { SettingsRepository } from '../../src/config/settings-repository.js';
import type { AppConfig } from '../../src/config/types.js';

/**
 * 单元测试专用的 Mock AppConfig 工厂辅助函数。
 * 默认绑定全局 setup 测试沙箱目录，避免物理开发区被污染。
 *
 * @param custom - 自定义覆盖的配置项
 * @returns 完整的 AppConfig 配置对象
 */
export function createMockAppConfig(custom?: Partial<AppConfig>): AppConfig {
  const workspace = custom?.workspace
    ?? process.env.AUTHORIZED_WORKSPACE_DIR
    ?? process.cwd();
  const applicationPaths = custom?.applicationPaths ?? createApplicationPaths(workspace, {
    appDataRoot: resolve(workspace, '.test-app-data'),
  });
  const settingsRepository = custom?.settingsRepository ?? new SettingsRepository(
    applicationPaths.userConfigDir,
    applicationPaths.projectConfigDir,
    {
      userSettingsPath: applicationPaths.userSettingsPath,
      projectSettingsPath: applicationPaths.projectSettingsPath,
      projectLocalSettingsPath: applicationPaths.projectLocalSettingsPath,
    },
  );

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
    mcp: {
      mcpServers: {},
    },
    permission: {
      defaultMode: 'default',
    },
    runtimeLimits: {
      maxIterations: 20,
      largeToolOutputLimit: 8000,
      readManyFilesLimit: 50000,
      searchLimit: 100,
      compactionWatermarkFactor: 0.8,
      loopPreventionLimit: 3,
      compactionRetainCount: 4,
      compactionRetainTokens: 8000,
      compactionSummaryMaxTokens: 4096,
      toolTimeoutMs: 30000,
      modelTimeoutMs: 60000,
      subagentMaxConcurrent: 4,
      subagentMaxInFlight: 16,
      subagentAutoBackgroundMs: 0,
      subagentForkEnabled: false,
    },
    diagnostics: {
      operationalEnabled: true,
      auditEnabled: true,
      replayEnabled: false,
      customPatterns: [],
      traceRetentionDays: 7,
      traceRetentionSessions: 20,
      auditRetentionDays: 7,
      auditRetentionSessions: 20,
    },
    skills: {
      backgroundReviewEnabled: true,
      creationNudgeInterval: 10,
      writeApproval: false,
    },
    curator: {
      enabled: true,
      intervalHours: 168,
      minIdleHours: 2,
      staleAfterDays: 30,
      archiveAfterDays: 90,
      consolidate: false,
      backup: {
        enabled: true,
        keep: 5,
      },
    },
    ...custom,
    autoMemoryEnabled: custom?.autoMemoryEnabled ?? true,
    workspace,
    applicationPaths,
    settingsRepository,
  };
}
