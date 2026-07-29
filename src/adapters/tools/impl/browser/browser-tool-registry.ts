/**
 * @file 浏览器工具注册清单。
 * 集中导出浏览器工具的实例列表，供 ToolCatalog 聚合。
 * 替代在 virtual-mcp.ts 中直接 import 并构造浏览器工具的旧模式。
 */

import {
  BrowserNavigateTool,
  BrowserClickTool,
  BrowserTypeTool,
  BrowserScrollTool,
  BrowserBackTool,
  BrowserPressTool,
  BrowserVisionTool,
  BrowserEnsureLoginTool,
  BrowserGetTextTool
} from './browser-action.js';
import type { NativeTool } from '../../tool-types.js';
import { BROWSER_TOOL_AUTHORIZATION_ADAPTERS } from '../../permissions/browser-tool-authorization.js';

/**
 * 获取浏览器工具的完整注册清单。
 * 每个浏览器工具必须绑定与真实动作匹配的正式权限适配器。
 *
 * @returns 浏览器工具实例数组
 */
export function getBrowserTools(): NativeTool[] {
  const tools: NativeTool[] = [
    new BrowserNavigateTool(),
    new BrowserClickTool(),
    new BrowserTypeTool(),
    new BrowserScrollTool(),
    new BrowserBackTool(),
    new BrowserPressTool(),
    new BrowserVisionTool(),
    new BrowserEnsureLoginTool(),
    new BrowserGetTextTool()
  ];
  for (const tool of tools) {
    const adapter = BROWSER_TOOL_AUTHORIZATION_ADAPTERS.get(tool.name);
    if (!adapter) {
      throw new Error(`浏览器工具 "${tool.name}" 缺少正式权限适配器`);
    }
    tool.authorizationAdapter = adapter;
  }
  return tools;
}
