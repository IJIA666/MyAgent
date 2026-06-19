## 新增需求

### 需求: 全局环境变量的 ESLint 物理阻断
系统必须（MUST）使用 ESLint 静态分析工具来限制非预期的 `process.env` 的直接读取。除指定的配置加载器（`loader.ts`）和单元测试（`*.test.ts`）在添加了行级 ESLint 逃逸注释的情况下被允许触碰 `process.env` 外，其余所有业务逻辑、插件、Native Tools 等文件在静态扫描时若存在直接访问 `process.env` 的语句，必须（MUST）抛出 ESLint 报错以阻断其合入或构建。

#### 场景: 非法读取 process.env 静态拦截
- **WHEN** 开发者在 `src/action/native-tools/terminal-config.ts` 或其他业务代码中直接写入 `process.env.AGENT_WORK_MODE`
- **THEN** 运行 lint 任务时，ESLint 静态扫描器必须报错并指出对应的环境变量拦截规则违规，强行阻断代码静态校验
