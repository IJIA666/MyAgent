/**
 * @fileoverview Vitest 全仓测试配置，统一测试发现、并发边界与覆盖率门槛。
 */

import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

// PowerShell AST 与 Playwright 测试会创建真实系统进程；限制文件工作进程，避免全量回归争抢系统资源。
const MAX_TEST_WORKERS = Math.min(4, availableParallelism());

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    maxWorkers: MAX_TEST_WORKERS,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: [
        'src/core/domain/**/*.ts',
        'src/core/usecases/security/**/*.ts',
        'src/adapters/tools/ToolCatalog.ts',
        'src/adapters/tools/ToolExecutor.ts',
        'src/adapters/tools/ToolAccessMetadataProvider.ts',
        'src/adapters/tools/toolRegistry.ts',
        'src/adapters/tools/tool-factory.ts',
        'src/adapters/tools/builtin-tool-policy-adapter.ts',
        'src/adapters/tools/tool-policy-router.ts',
        'src/core/usecases/brain/ContextRepository.ts',
      ],
      thresholds: {
        // 按真实源码范围配置防回退阈值，避免用一个全局数字掩盖关键目录之间的覆盖率差异。
        'src/core/domain/**/*.ts': { statements: 80, branches: 70 },
        'src/core/usecases/security/**/*.ts': { statements: 75, branches: 65 },
        'src/adapters/tools/ToolCatalog.ts': { statements: 70, branches: 60 },
        'src/adapters/tools/ToolExecutor.ts': { statements: 70, branches: 60 },
        'src/adapters/tools/ToolAccessMetadataProvider.ts': { statements: 70, branches: 60 },
        'src/adapters/tools/toolRegistry.ts': { statements: 70, branches: 60 },
        'src/adapters/tools/tool-factory.ts': { statements: 70, branches: 60 },
        'src/adapters/tools/builtin-tool-policy-adapter.ts': { statements: 70, branches: 60 },
        'src/adapters/tools/tool-policy-router.ts': { statements: 70, branches: 60 },
        'src/core/usecases/brain/ContextRepository.ts': { statements: 65, branches: 55 },
      },
    },
  },
});
