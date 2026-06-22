import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintPluginN from 'eslint-plugin-n';

export default [
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["node_modules/**", "dist/**", "openspec/**", ".agents/**", "**/.venv/**"],
  },
  {
    plugins: {
      n: eslintPluginN,
    },
    rules: {
      // 默认全局开启 no-console 诊断，防止滥用调试打印
      "no-console": "error",
      // 物理阻断业务代码直接读取全局 process.env 变量，强制统一走配置加载与依赖注入层
      "n/no-process-env": "error",
    },
  },
  {
    // CLI 交互展现层、启动入口文件以及命令行运行/辅助测试脚本放开 console 限制以支持正常的 UI 渲染和 Banner
    files: [
      "src/adapters/input/**/*.ts",
      "src/index.ts",
      "src/adapters/tools/tools/system/terminal-interactive.ts",
      "test/scripts/**/*.ts"
    ],
    rules: {
      "no-console": "off",
    },
  },
  {
    // 日志系统底层工具类允许直接读取 process.env 环境变量
    files: ["src/utils/logger.ts"],
    rules: {
      "n/no-process-env": "off",
    },
  },
];
