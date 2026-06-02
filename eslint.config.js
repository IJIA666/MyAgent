import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["node_modules/**", "dist/**", "openspec/**", ".agents/**", ".venv/**"],
  },
  {
    rules: {
      // 因为是 CLI 应用，允许使用 console
      "no-console": "off",
    },
  }
];
