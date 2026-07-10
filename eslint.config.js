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
      // 允许以下划线开头的函数参数不触发未使用警告（常见于接口实现中的占位参数）
      "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }],
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
    // 配置环境入口与测试基础设施允许直接读取 process.env 环境变量
    files: ["src/config/env.ts", "src/utils/logger.ts", "test/**/*.ts"],
    rules: {
      "n/no-process-env": "off",
    },
  },
];
