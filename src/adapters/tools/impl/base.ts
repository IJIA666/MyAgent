/**
 * 智能体沙箱基础安全控制与路径验证模块。
 * 负责授权工作区的全局初始化与获取，提供防范路径遍历与符号链接越权攻击的安全路径解析核心校验器。
 */

import { resolve, sep, dirname } from 'path';
import { realpathSync, existsSync } from 'fs';
import type { SessionEventPort } from '../../../ports/driven/session/SessionEventPort.js';
import type { ToolExecutionContext } from '../../../core/usecases/plugins/plugin-types.js';

/**
 * 授权工作区的绝对物理路径。
 * 通过 initWorkspace() 延迟物理初始化，锁定真实的物理真实路径。
 */
let authorizedDir: string | null = null;
/**
 * 当前项目长期记忆目录的绝对物理路径。
 * 由 initWorkspace 显式注入，在路径边界校验中与 authorizedDir 并列作为合法根。
 */
let authorizedMemoryDir: string | null = null;

export function getAuthorizedDir(): string | null {
  return authorizedDir;
}

/**
 * 将一个可能存在或不存在的路径，通过对其最接近的已存在祖先目录执行 realpathSync，
 * 解析并还原出其真实的物理绝对路径。用来抵御基于符号链接和挂载点的沙箱越界逃逸。
 * 
 * @param target - 具有潜在风险的目标文件或目录路径
 * @returns 还原出的真实物理绝对路径
 */
export function getPhysicalRealPath(target: string): string {
  let current = resolve(target);
  const parts: string[] = [];
  
  // 循环向上寻找在磁盘上确实存在的祖先节点
  while (!existsSync(current)) {
    const parent = dirname(current);
    // 如果到达了根目录，直接跳出以防死循环
    if (parent === current) {
      break;
    }
    // 记录未创建的子路径部分
    parts.unshift(current.slice(parent.length).replace(/^[\\/]+/, ''));
    current = parent;
  }
  
  // 对已存在的祖先节点执行物理 realpathSync 解析以追踪符号链接
  const resolvedParent = realpathSync(current);
  
  // 将未创建 of 子路径拼回到解析后的物理祖先路径上
  return parts.length > 0 ? resolve(resolvedParent, ...parts) : resolvedParent;
}

/**
 * 初始化授权工作区路径与可选的长期记忆目录。
 * 在应用启动阶段由 index.ts 调用一次，强制将其转换为物理真实绝对路径。
 * 重复调用时必须整体替换两个授权根，避免测试或多会话复用旧项目的记忆根。
 *
 * @param rootDir - 工作区配置路径
 * @param memoryDir - 可选。当前项目的长期记忆目录，注入后标准文件工具可访问其子树
 */
export function initWorkspace(rootDir: string, memoryDir?: string): void {
  // 强制通过 getPhysicalRealPath 对工作区根目录进行符号链接展开与物理定位
  authorizedDir = getPhysicalRealPath(rootDir);
  // 记忆目录为可选；提供时同样进行物理路径解析，不存在时尝试解析其父目录。
  // 未提供时必须显式置空，避免多会话复用旧项目的记忆根。
  authorizedMemoryDir = memoryDir ? getPhysicalRealPath(memoryDir) : null;
}
/**
 * 检查指定路径是否已存在于临时只读白名单中。
 * @param pathStr - 待检查的物理路径
 * @param sessionContext - 可选的会话事件只读契约
 * @returns 是否在白名单中
 */
export function hasTemporaryReadWhitelist(pathStr: string, sessionContext?: SessionEventPort): boolean {
  return sessionContext ? sessionContext.hasTemporaryReadWhitelist(pathStr) : false;
}

/**
 * 检查指定路径是否已存在于临时可写白名单中。
 * @param pathStr - 待检查的物理路径
 * @param sessionContext - 可选的会话事件只读契约
 * @returns 是否在白名单中
 */
export function hasTemporaryWriteWhitelist(pathStr: string, sessionContext?: SessionEventPort): boolean {
  return sessionContext ? sessionContext.hasTemporaryWriteWhitelist(pathStr) : false;
}

/**
 * 判定目标物理路径是否在授权目录安全防护边界内。
 * 针对 Windows 平台下文件或目录尚未创建时（ realpathSync 无法对未存在子目录完全大小写对齐 ）导致的盘符或大小写不一致进行不敏感兼容判定。
 *
 * @param parent - 授权工作区的绝对物理路径
 * @param child - 经过规范化后的绝对物理路径
 * @returns 是否在边界内
 */
function isSubPath(parent: string, child: string): boolean {
  if (process.platform === 'win32') {
    const p = parent.toLowerCase();
    const c = child.toLowerCase();
    return c === p || c.startsWith(p + sep);
  }
  return child === parent || child.startsWith(parent + sep);
}

/**
 * 检查目标物理路径是否处于任一授权根（工作区或记忆目录）的子树内。
 *
 * @param resolvedPath - 已解析的物理绝对路径
 * @returns 在授权范围内返回 true
 */
function isWithinAnyAuthorizedRoot(resolvedPath: string): boolean {
  if (authorizedDir && isSubPath(authorizedDir, resolvedPath)) {
    return true;
  }
  if (authorizedMemoryDir && isSubPath(authorizedMemoryDir, resolvedPath)) {
    return true;
  }
  return false;
}

/**
 * 统一安全路径解析：将目标路径基于授权根解析为物理绝对路径，并校验边界。
 * 按序尝试：authorizedDir → authorizedMemoryDir（若存在）。
 *
 * @param targetPath - 入参目标文件或目录路径（相对或绝对）
 * @returns 校验通过的安全物理绝对路径
 * @throws 当工作区未初始化或路径越权时抛出错误
 */
export function secureResolvePath(targetPath: string): string {
  if (authorizedDir === null) {
    throw new Error('工作区尚未初始化。请确保在使用文件工具前调用 initWorkspace()。');
  }

  // 首先尝试基于 authorizedDir 解析
  const rawPath = resolve(authorizedDir, targetPath);
  const resolvedPath = getPhysicalRealPath(rawPath);

  // 检查是否在 authorizedDir 或 authorizedMemoryDir 子树内
  if (isWithinAnyAuthorizedRoot(resolvedPath)) {
    return resolvedPath;
  }

  // 若目标路径本身是绝对路径且经 authorizedDir 解析后超出了范围，尝试直接按绝对路径
  // 检查其是否位于 authorizedMemoryDir 内（绕过 authorizedDir 前缀解析）
  if (targetPath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(targetPath)) {
    const directResolved = getPhysicalRealPath(targetPath);
    if (authorizedMemoryDir && isSubPath(authorizedMemoryDir, directResolved)) {
      return directResolved;
    }
  }

  throw new Error(`拒绝访问：目标路径 "${targetPath}" 溢出了授权工作区或记忆目录的安全防护边界。`);
}

/**
 * 文件只读操作安全路径校验器。
 * 接受 SessionEventPort（向后兼容）或 ToolExecutionContext。
 * 优先检查 call capability（access='read'），再检查 session 白名单，最后检查沙箱边界。
 *
 * @param targetPath - 待读取的目标相对或绝对路径
 * @param context - 可选的会话上下文（SessionEventPort）或工具调用执行上下文（ToolExecutionContext）
 * @returns 解析规范后的安全物理绝对路径
 */
export function secureResolveReadPath(targetPath: string, context?: SessionEventPort | ToolExecutionContext): string {
  if (authorizedDir === null) {
    throw new Error('工作区尚未初始化。请确保在使用文件工具前调用 initWorkspace()。');
  }

  const rawPath = resolve(authorizedDir, targetPath);
  const resolvedPath = getPhysicalRealPath(rawPath);

  // 提取 SessionContext（兼容 ToolExecutionContext 包裹层和直接的 SessionEventPort）
  const sessionCtx = context
    ? ('toolCallId' in context ? (context as ToolExecutionContext).sessionContext : context as SessionEventPort)
    : undefined;

  // 0. 优先检查 ToolExecutionContext 的 call capability（access='read'）
  if (context && 'toolCallId' in context) {
    if ((context as ToolExecutionContext).sessionContext.hasClaimedResource((context as ToolExecutionContext).toolCallId, 'read', resolvedPath)) {
      return resolvedPath;
    }
  }

  // 1. 安全放行：如果目标物理路径已被临时授权加入只读白名单
  if (sessionCtx && typeof sessionCtx.hasTemporaryReadWhitelist === 'function' && sessionCtx.hasTemporaryReadWhitelist(resolvedPath)) {
    return resolvedPath;
  }

  // 2. 常规校验：判断是否在 authorizedDir 或 authorizedMemoryDir 授权边界内
  if (!isWithinAnyAuthorizedRoot(resolvedPath)) {
    // 对绝对路径尝试直接解析并检查 authorizedMemoryDir
    if ((targetPath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(targetPath)) && authorizedMemoryDir) {
      const directResolved = getPhysicalRealPath(targetPath);
      if (isSubPath(authorizedMemoryDir, directResolved)) {
        return directResolved;
      }
    }
    throw new Error(`拒绝访问：目标路径 "${targetPath}" 溢出了授权工作区或记忆目录的安全防护边界。`);
  }

  return resolvedPath;
}

/**
 * 文件写入/修改操作安全路径校验器。
 * 接受 SessionEventPort（向后兼容）或 ToolExecutionContext。
 * 优先检查 call capability（access='write'），再检查 session 白名单，最后检查沙箱边界。
 *
 * @param targetPath - 待写入的目标相对或绝对路径
 * @param context - 可选的会话上下文（SessionEventPort）或工具调用执行上下文（ToolExecutionContext）
 * @returns 解析规范后的安全物理绝对路径
 */
export function secureResolveWritePath(targetPath: string, context?: SessionEventPort | ToolExecutionContext): string {
  if (authorizedDir === null) {
    throw new Error('工作区尚未初始化。请确保在使用文件工具前调用 initWorkspace()。');
  }

  const rawPath = resolve(authorizedDir, targetPath);
  const resolvedPath = getPhysicalRealPath(rawPath);

  // 提取 SessionContext（兼容 ToolExecutionContext 包裹层和直接的 SessionEventPort）
  const sessionCtx = context
    ? ('toolCallId' in context ? (context as ToolExecutionContext).sessionContext : context as SessionEventPort)
    : undefined;

  // 0. 优先检查 ToolExecutionContext 的 call capability（access='write'）
  if (context && 'toolCallId' in context) {
    if ((context as ToolExecutionContext).sessionContext.hasClaimedResource((context as ToolExecutionContext).toolCallId, 'write', resolvedPath)) {
      return resolvedPath;
    }
  }

  // 1. 安全放行：如果目标物理路径已被临时授权加入可写白名单
  if (sessionCtx && typeof sessionCtx.hasTemporaryWriteWhitelist === 'function' && sessionCtx.hasTemporaryWriteWhitelist(resolvedPath)) {
    return resolvedPath;
  }

  // 2. 常规校验：判断是否在 authorizedDir 或 authorizedMemoryDir 授权边界内
  if (!isWithinAnyAuthorizedRoot(resolvedPath)) {
    // 对绝对路径尝试直接解析并检查 authorizedMemoryDir
    if ((targetPath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(targetPath)) && authorizedMemoryDir) {
      const directResolved = getPhysicalRealPath(targetPath);
      if (isSubPath(authorizedMemoryDir, directResolved)) {
        return directResolved;
      }
    }
    throw new Error(`拒绝访问：目标路径 "${targetPath}" 溢出了授权工作区或记忆目录的安全防护边界。`);
  }

  return resolvedPath;
}
