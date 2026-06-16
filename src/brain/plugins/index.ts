/**
 * @file 智能体 Hook 插件库统一导出索引文件。
 * 核心职责：
 * 1. 导出 Token 水位监测插件。
 * 2. 导出 JIT 规则动态伴生注入插件。
 * 3. 导出执行足迹与 Immer patches 审计日志插件。
 * 4. 导出工具死循环与熔断防护插件。
 */

export { TokenWatermarkPlugin } from './TokenWatermarkPlugin.js';
export { JitRulesPlugin } from './JitRulesPlugin.js';
export { TracerLogPlugin } from './TracerLogPlugin.js';
export { LoopPreventionPlugin } from './LoopPreventionPlugin.js';
