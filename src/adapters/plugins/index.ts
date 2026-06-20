/**
 * @file 智能体 Hook 插件库统一导出索引文件。
 * 核心职责：
 * 1. 统一对外提供插件强类型定义与中间件运行管道。
 * 2. 导出 Token 水位监测、JIT 规则伴生、Trace 审计与死循环熔断等四个切面业务插件。
 */

export * from '../../core/usecases/plugin-types.js';
export { PluginRegistry } from '../../core/usecases/plugin-registry.js';
export { runHookPipeline } from '../../core/usecases/plugin-runner.js';

export { TokenWatermarkPlugin } from './TokenWatermarkPlugin.js';
export { JitRulesPlugin } from './JitRulesPlugin.js';
export { TracerLogPlugin } from './TracerLogPlugin.js';
export { LoopPreventionPlugin } from './LoopPreventionPlugin.js';
export { HumanApprovalPlugin } from './HumanApprovalPlugin.js';
