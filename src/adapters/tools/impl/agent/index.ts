import { AgentTool } from './AgentTool.js';

/** Agent 原生工具聚合入口。 */
export function getAgentTools(): AgentTool[] {
  return [new AgentTool()];
}

export { AgentTool } from './AgentTool.js';
