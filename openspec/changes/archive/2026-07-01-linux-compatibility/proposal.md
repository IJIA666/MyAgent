## 改造原因

目前 `MyAgent` 主要在 Windows 本地环境下执行日常开发与测试，所有的编译与 Vitest 测试也在 Windows 环境中跑通。然而，工业级 Agent 系统的生产部署、容器化安全隔离沙箱（如 Docker / Devcontainer）、CI/CD 自动化流水线以及主流第三方 MCP 服务均以 Linux (POSIX) 平台为主导。

这导致我们面临以下问题：
1. **测试反馈盲区**：Windows 开发环境下由于路径分隔符、大小写敏感等特性的差异性宽容，很容易引入在 Linux 下会静默出错的路径硬编码，这在没有 Linux 自动化测试流水线的情况下是完全隐形的。
2. **容器沙箱化受限**：由于没有对 Linux 环境的兼容守护，我们无法在受限的 Linux 容器内正常部署运行 Agent，这严重制约了 Agent 的逃逸安全防护。
3. **工具生态集成受限**：许多第三方开源 MCP 服务器仅支持在 Unix-like 下运行，缺乏 Linux 适配限制了工具链的扩展能力。

## 变更内容

本变更为纯平台兼容性适配，主要包括以下非破坏性（NON-BREAKING）变更：
1. **跨平台路径与代码缺陷修复**：在本地 WSL 或 Linux 容器内进行单测校验，重点排查并修复工具和测试代码中可能存在的硬编码反斜杠 `\\` 或 `replace(/\\/g, '/')` 等不兼容路径操作，将其重构为平台感知的标准路径 API。
2. **Linux 环境测试通过**：本地 Linux 环境下的所有单元测试与集成测试（`npm run test` 和 `npm run test:integration`）达到 **100% 绿色通过，且无任何残留报错**。
3. **GitHub Actions 自动化流水线建立**：在项目根目录下生成并提交 [`.github/workflows/ci.yml`](file:///d:/projects/MyAgent/.github/workflows/ci.yml) 配置文件，在每次代码推送（Push）或拉取请求（PR）时自动拉起 `ubuntu-latest` 容器执行编译、代码规范扫描（Linter）与单元测试运行，实现 Linux 兼容性的长效自动化守护。

## 业务能力

### 新增业务能力
- `linux-compatibility`: 支持 Linux 平台环境适配与测试运行，并引入 CI 自动化测试流水线。

### 修改业务能力
- 无（不修改既有的业务功能规格）

## 影响范围

- **受影响代码**：工具实现（`src/adapters/` 目录下各 native tools）以及测试代码（`test/` 目录下各测试套件）中硬编码路径分隔符的规范化。
- **新增配置**：在项目根目录新增 [`.github/workflows/ci.yml`](file:///d:/projects/MyAgent/.github/workflows/ci.yml) 自动化 CI 配置文件。
- **环境依赖**：Linux 环境运行单元测试时，如果涉及浏览器无头爬网，需要确保容器中正确装载 Playwright 的动态依赖包。
