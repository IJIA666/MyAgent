## 1. 跨平台路径排查与代码缺陷修复 (Cross-Platform Path Scanning)

- [x] 1.1 全局扫描 `src/adapters/` 目录下的本地工具实现，定位并重构任何硬编码的反斜杠 `\\` 或平台不敏感的 `replace(/\\/g, '/')` 路径逻辑，使用标准路径 API 代替。
- [x] 1.2 全局扫描 `test/` 目录下的测试文件，修复其中由于 Windows 路径分隔符而强耦合的测试代码 and 路径拼接。
- [x] 1.3 本地执行项目编译，确保修改后无编译与语法错误。

<!-- checkpoint: npm run build -->

## 2. 本地 Linux 测试验证 (Local Linux Testing)

- [x] 2.1 在 WSL (Windows Subsystem for Linux) 或拉起的 Node-Linux 开发容器中，执行项目依赖安装。
- [x] 2.2 在 Linux 环境内运行单元测试，排查并解决所有由于平台排异或硬编码路径引发的失败用例，直到单元测试 100% 绿色通过。
- [x] 2.3 在 Linux 环境内运行集成测试，确保所有集成用例 100% 绿色通过。

<!-- checkpoint: npm run test -->

## 3. CI/CD 流水线建立与云端验证 (CI Pipeline Establishment)

- [x] 3.1 在项目根目录下创建并编写 [`.github/workflows/ci.yml`](file:///d:/projects/MyAgent/.github/workflows/ci.yml) 自动化构建配置文件，设定在 `ubuntu-latest` 容器上顺序运行代码规范扫描（`npm run lint`）、项目编译（`npm run build`）及测试套件。
- [x] 3.2 在工作流脚本中添加 `npx playwright install-deps` 步骤，用以自动安装拉起无头 Chromium 浏览器所需的全部动态链接依赖库。
- [x] 3.3 [人工] 提交 `.github/workflows/ci.yml` 配置文件，推送至远程 GitHub 仓库，并在 GitHub Actions 页面上确认流水线首次运行 100% 绿色通过。

<!-- checkpoint: npm run build -->
