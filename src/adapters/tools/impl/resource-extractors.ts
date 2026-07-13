/**
 * @file 资源提取器工厂函数。
 * 提供常用的资源提取器构造器，供各工具模块在其注册清单中为 NativeTool 注入 resourceExtractor。
 * 替代集中式 registerExtractorsForBuiltinTools() 按工具名分支的旧模式。
 */

import { resolve } from 'path';
import type { ResourceExtractor } from '../../../ports/driven/tools/ToolAccessMetadataPort.js';
import { getAuthorizedDir } from './base.js';
import { extractSafePrefix } from './system/terminal.js';

/**
 * 获取资源提取器使用的路径解析基准目录。
 * 优先复用工具沙箱已初始化的授权工作区，避免与真实执行路径基准不一致。
 */
function getExtractionBaseDir(): string {
  return getAuthorizedDir() ?? process.cwd();
}

/**
 * 创建单一路径提取器。
 *
 * @param pathKey - 工具参数中路径字段的键名
 * @param access - 访问模式（'read' 或 'write'）
 */
export function pathExtractor(pathKey: string, access: 'read' | 'write'): ResourceExtractor {
  return (args) => {
    const cwd = getExtractionBaseDir();
    const rawPath = args[pathKey];
    if (typeof rawPath === 'string' && rawPath.trim()) {
      return [{ kind: 'path', access, normalizedPath: resolve(cwd, rawPath.trim()) }];
    }
    return [];
  };
}

/**
 * 创建多路径提取器（用于 readManyFiles、grepSearch 等支持多路径的工具）。
 *
 * @param pathKey - 工具参数中路径字段的键名
 * @param access - 访问模式
 */
export function multiPathExtractor(pathKey: string, access: 'read' | 'write'): ResourceExtractor {
  return (args) => {
    const cwd = getExtractionBaseDir();
    const rawPaths = args[pathKey];
    if (typeof rawPaths === 'string') {
      let paths: string[];
      try {
        const parsed = JSON.parse(rawPaths);
        paths = Array.isArray(parsed) ? parsed.map(String) : [rawPaths.trim()];
      } catch {
        paths = rawPaths.split(',').map(s => s.trim()).filter(Boolean);
      }
      return paths.map(p => ({ kind: 'path' as const, access, normalizedPath: resolve(cwd, p) }));
    }
    return [];
  };
}

/**
 * 创建目录范围提取器（用于 listFiles 等目录枚举工具）。
 *
 * @param pathKey - 工具参数中目录路径字段的键名
 */
export function directoryScopeExtractor(pathKey: string): ResourceExtractor {
  return (args) => {
    const cwd = getExtractionBaseDir();
    const rawPath = args[pathKey];
    if (typeof rawPath === 'string' && rawPath.trim()) {
      return [{ kind: 'directory-scope', access: 'read', normalizedPath: resolve(cwd, rawPath.trim()) }];
    }
    return [{ kind: 'directory-scope', access: 'read', normalizedPath: resolve(cwd, '.') }];
  };
}

/**
 * 创建命令前缀提取器（用于 Bash 和 PowerShell 工具）。
 */
export function commandPrefixExtractor(): ResourceExtractor {
  return (args) => {
    const command = args.command;
    if (typeof command === 'string' && command.trim()) {
      const safePrefix = extractSafePrefix(command);
      if (safePrefix) {
        return [{ kind: 'command-prefix', prefix: safePrefix }];
      }
    }
    return [];
  };
}

/**
 * 创建双路径提取器（用于 movePath、copyPath 等同时涉及源和目标路径的工具）。
 *
 * @param sourceKey - 源路径参数字段键名
 * @param sourceAccess - 源路径的访问模式
 * @param destKey - 目标路径参数字段键名
 * @param destAccess - 目标路径的访问模式
 */
export function dualPathExtractor(
  sourceKey: string,
  sourceAccess: 'read' | 'write',
  destKey: string,
  destAccess: 'read' | 'write'
): ResourceExtractor {
  return (args) => {
    const cwd = getExtractionBaseDir();
    const resources: ReturnType<ResourceExtractor> = [];
    const source = args[sourceKey];
    const dest = args[destKey];
    if (typeof source === 'string' && source.trim()) {
      resources.push({ kind: 'path', access: sourceAccess, normalizedPath: resolve(cwd, source.trim()) });
    }
    if (typeof dest === 'string' && dest.trim()) {
      resources.push({ kind: 'path', access: destAccess, normalizedPath: resolve(cwd, dest.trim()) });
    }
    return resources;
  };
}

/**
 * 创建 grep 搜索路径提取器。
 * 支持逗号分隔的多路径解析。
 *
 * @param pathKey - 路径参数字段键名
 */
export function grepSearchExtractor(pathKey: string): ResourceExtractor {
  return (args) => {
    const cwd = getExtractionBaseDir();
    const rawPath = args[pathKey];
    if (typeof rawPath === 'string' && rawPath.trim()) {
      const paths = rawPath.split(',').map(s => s.trim()).filter(Boolean);
      return paths.map(p => ({ kind: 'path' as const, access: 'read' as const, normalizedPath: resolve(cwd, p) }));
    }
    return [];
  };
}

/**
 * 空提取器——工具无法从参数提取可校验资源时使用。
 */
export function emptyExtractor(): ResourceExtractor {
  return () => [];
}
