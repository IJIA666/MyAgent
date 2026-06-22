## 背景

当前系统的核心痛点是在规则配置与代码编写层面存在“掩耳盗铃”的防御性过度与耦合违规：
1. **ESLint 豁免赘余**：`eslint.config.js` 全局豁免了 logger.ts 文件的控制台打印以及 test 下的所有 console 输出，实际上 logger 内部使用的是封装的 LogTape，测试文件亦不需要全局放开 console。
2. **测试类型契约退化**：测试套件为了编写 mock 方便，全局豁免了 `@typescript-eslint/no-explicit-any`，导致大面积使用 `as any`，使得一旦 Driven Port 接口发生变化，测试代码无法在编译期自动察觉。
3. **依赖注入架构被污染**：`core/usecases` 业务核心层由于 `appConfig` 设计为可选参数，导致在获取工作区根路径时直接强行读取全局 `process.env.AUTHORIZED_WORKSPACE_DIR`。这与系统由装配层（`loader.ts`）统一装配配置并隔离全局状态的设计初衷相悖，且会使得将来在多租户/并发实例下因共享环境变量导致目录冲突。

为了解决上述问题，本设计提出了一套彻底清除冗余例外、利用 Mock 辅助工厂强化类型安全、并将 appConfig 约束为必传以彻底打通工作区依赖注入的技术方案。

## 目标与非目标

**目标:**
- 移除 `eslint.config.js` 中 `src/utils/logger.ts` 的 `no-console: off` 豁免，并将测试的控制台豁免收窄至 `test/scripts/**` 的 CLI 运行脚本中。
- 移除 `@typescript-eslint/no-explicit-any: off` 测试豁免。通过显式接口转型消灭测试中所有的 `as any`。
- 将 `SessionManager` 的构造参数 `appConfig` 变更为必传参数 (`appConfig: AppConfig`)。
- 彻底移除 `src/core/usecases` 核心业务逻辑中对 `process.env.AUTHORIZED_WORKSPACE_DIR` 的直接读取。

**非目标:**
- 不引入与本次重构无关的 ESLint 约束规则或修改系统构建脚本。
- 不修改大语言模型驱动（`LlmPort`）、向量数据库（`VectorDbPort`）等 Driven 端口的 API 签名，仅重构它们在测试中的 Mock 实现及初始化装配方式。

## 架构决策

### 1. 新增公用 Mock 工厂模块 `test/mock-factory.ts`
为了防止在各测试文件中重复声明冗长的 Mock `AppConfig`，将新建一个独立的测试辅助文件 `test/mock-factory.ts`。
该文件提供 `createMockAppConfig(custom?: Partial<AppConfig>): AppConfig`。其默认工作区将绑定为：
```typescript
workspace: process.env.AUTHORIZED_WORKSPACE_DIR || process.cwd()
```
从而保证测试在无参调用 Mock 配置时，自动无缝承接 `test/setup.ts` 在全局测试启动前注入的沙箱工作区路径，防止测试落盘污染物理源码开发区。

### 2. 强契约化参数注入
重构 `SessionManager` 的构造方法，要求 `appConfig: AppConfig` 为必传参数。这保证了：
- 系统默认兜底配置逻辑（如 `maxIterations` 等限制参数）完全收拢到配置装配阶段（`loader.ts`）统一处理，避免默认值在多处重复声明。
- 强制测试文件在实例化 `SessionManager` 时必须传入一致的配置，消除了隐式配置降级的系统漏洞。

### 3. 双优先级测试沙箱隔离路径设计
在 `ContextRepository` 重构中，为了不破坏其单元测试能够自由指定临时写入目录的能力，保留构造函数中的 `workspacePath?: string`。
在内部退化路径中，改为优先读取 `workspacePath`，兜底读取 `this.context.appConfig.workspace || process.cwd()`：
```typescript
const baseDir = this.workspacePath || this.context.appConfig?.workspace || process.cwd();
```
这一机制既保证了单元测试的绝对沙箱物理隔离（通过 `workspacePath` 传参），又使生产运行时能完美接入注入的工作区绝对路径，彻底踢除对 `process.env` 的耦合。

### 4. 私有方法的显式类型擦除 Spy 转型
对于部分测试中需要 spyOn 类的私有成员方法（如 `rebuildVectorDbIfEmpty`），由于 TypeScript 编译器的可见性限制，原先不得不使用 `as any`。本方案决定改写为显式的局部匿名接口转型，从而在不破坏类型检查的前提下绕过编译器检查：
```typescript
vi.spyOn(
  SessionManager.prototype as unknown as { rebuildVectorDbIfEmpty: () => Promise<void> },
  'rebuildVectorDbIfEmpty'
).mockResolvedValue(undefined);
```

## 风险与权衡

- **[风险点]：重构 `appConfig` 为必传参数导致测试文件大面积编译失败**
  - **[缓解策略]**：通过 `test/mock-factory.ts` 统一承载。精确检索表明，整个测试套件共计只有 8 处实例化 `SessionManager`，工作量适中，重构成本完全可控。
- **[风险点]：移除 any 豁免后，外部依赖包部分缺少 TSDoc 或未暴露的底层类型引起类型报错**
  - **[缓解策略]**：严格限制使用 `as unknown as Port` 对 mock 对象转为受限的端口定义，而不使用通配符 any，这能在接口层面建立完整的契约验证壁垒。
