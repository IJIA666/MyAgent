/**
 * 终端 Shell 抽象层类型定义。
 * 核心职责：
 * 1. 定义 ShellFamily 枚举与解析后的具体 shell 类型；
 * 2. 定义 ShellExecutionPlan 不可变数据对象接口；
 * 3. 定义 PlatformExecutionOptions 平台特化选项接口。
 */

/** Shell 家族枚举，作为平台 shell 语义的受控入口。 */
export type ShellKind = 'auto' | 'posix' | 'powershell' | 'cmd';

/** 已决议的具体 shell family（`auto` 已在 Plan 工厂阶段被解析为具体值）。 */
export type ResolvedShellKind = 'posix' | 'powershell' | 'cmd';

/** 平台特化执行选项 */
export interface PlatformExecutionOptions {
  /** 进程树强杀命令模板，`{pid}` 为占位符；`null` 表示使用 `process.kill(pid, 'SIGKILL')` */
  readonly killCommand: string[] | null;
  /** npm/npx CLI 路径重定向是否需要（Windows + shell: false 场景） */
  readonly npmRewrite: boolean;
  /** PowerShell 终端输出编码引导脚本；仅在 `shellKind=powershell` 时预置，否则为 `null` */
  readonly encodingBootstrap: string | null;
  /** shell: false 执行模式确认标志 */
  readonly shellFlag: boolean;
}

/** 终端执行计划，由工厂函数根据 shellKind + 原始命令一次性生成，不可变。 */
export interface ShellExecutionPlan {
  /** 已决议的 shell 家族 */
  readonly shellKind: ResolvedShellKind;
  /** 归一化后的核心命令文本 */
  readonly coreCommand: string;
  /** 可执行文件路径 */
  readonly executable: string;
  /** 命令行参数数组 */
  readonly argv: string[];
  /** 平台特化执行选项 */
  readonly platformOptions: PlatformExecutionOptions;
}
