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
import type { NativeTool } from '../../virtual-mcp.js';
import { emptyExtractor } from '../resource-extractors.js';

/**
 * 获取浏览器工具的完整注册清单。
 * 浏览器工具不涉及文件路径操作，使用空提取器。
 *
 * @returns 浏览器工具实例数组
 */
export function getBrowserTools(): NativeTool[] {
  const empty = emptyExtractor();
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
    tool.resourceExtractor = empty;
  }
  return tools;
}
