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
      // 因为是 CLI 应用，允许使用 console
      "no-console": "off",
      // 物理阻断业务代码直接读取全局 process.env 变量，强制统一走配置加载与依赖注入层
      "n/no-process-env": "error",
    },
  }
];
