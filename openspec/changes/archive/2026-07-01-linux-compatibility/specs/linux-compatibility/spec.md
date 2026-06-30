## 新增需求

### Requirement: 跨平台路径解析与安全性
工具实现与测试代码中的物理路径合成与沙箱判断逻辑必须（MUST）使用平台自适应的标准路径 API（如 `path.join`、`path.resolve` 和 `path.sep`），绝对禁止硬编码反斜杠 `\\` 等平台特定分隔符，确保多平台运行下的路径安全性。

#### Scenario: 平台自适应路径合成
- **WHEN** 系统在 Windows 或 Linux 环境下合成绝对路径并进行沙箱安全校验时
- **THEN** 合成出的路径必须自动使用当前操作系统的标准文件分隔符，且沙箱判定 `isSubPath` 结果正确、不出现误判。

### Requirement: 本地 Linux 编译与测试全绿运行
所有的单元测试与集成测试用例必须（MUST）能够无障碍地在 Linux（如 WSL 或 Node-Linux 容器）环境下执行并通过，确保无任何由于平台排异或硬编码路径导致的失败测试残留。

#### Scenario: 本地 Linux 测试运行
- **WHEN** 在本地 WSL 或 Docker Linux 容器中执行 `npm run test` 与 `npm run test:integration`
- **THEN** 测试套件应当能顺畅定位到所有关联测试文件，执行后最终结果必须全部通过（100% Green）。

### Requirement: CI/CD 自动化流水线守护
项目必须（MUST）在根目录下引入 [`.github/workflows/ci.yml`](file:///d:/projects/MyAgent/.github/workflows/ci.yml) 自动化构建配置文件，在代码提交至远程仓库时，在云端 Linux 容器内全自动跑起质量守护。

#### Scenario: GitHub Actions 触发校验
- **WHEN** 代码被推送（Push）到项目仓库或提交 PR 时
- **THEN** GitHub Actions 应当在 `ubuntu-latest` 容器中拉起构建，安装依赖（含无头 Playwright 依赖），顺序执行编译、Lint 扫描与单元测试运行，且流水线整条绿色通过。
