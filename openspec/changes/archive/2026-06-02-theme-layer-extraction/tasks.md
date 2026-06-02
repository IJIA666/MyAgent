## 1. 创建 Theme 层基建

- [x] 1.1 创建 `src/interface/theme.ts` 文件
- [x] 1.2 在 `theme.ts` 中实现 `success`, `error`, `dim`, `info`, `highlight` 等高阶包裹函数，强制要求在末尾包含复位符 `\x1b[0m`

<!-- checkpoint: npx tsc --noEmit -->

## 2. 剥离并重构 CLI 循环层

- [x] 2.1 移除 `src/interface/cli.ts` 中的所有 `COLOR_*` 常量定义
- [x] 2.2 替换 `src/interface/cli.ts` 中所有的颜色字符串硬编码逻辑，将其全面切流至 `theme.*` 模块方法

<!-- checkpoint: npx tsc --noEmit -->

## 3. 剥离并重构指令路由层

- [x] 3.1 移除 `src/interface/command.ts` 中的所有 `COLOR_*` 常量定义
- [x] 3.2 替换 `src/interface/command.ts` 中所有的颜色字符串硬编码逻辑，将其全面切流至 `theme.*` 模块方法

<!-- checkpoint: npx tsc --noEmit -->
