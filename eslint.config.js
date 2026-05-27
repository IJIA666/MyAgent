import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["node_modules/**", "dist/**", "openspec/**", ".agents/**"],
  },
  {
    rules: {
      // 这里的 any 警告先调整为 warn，因为目前代码中有用到 any 的地方
      "@typescript-eslint/no-explicit-any": "warn",
      // 因为是 CLI 应用，允许使用 console
      "no-console": "off",
    },
  }
);
