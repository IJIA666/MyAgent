/**
 * @file Claude 风格 Auto Memory 路径判定与权限策略。
 * 默认记忆根是文件权限基线的一部分，维护性读/写/创建目录直接 allow；
 * 自定义根只提供读取便利，写入仍走普通规则与模式。
 * 显式 deny/hard cap 先于特例。
 */

import { isAbsolute, relative, resolve } from 'node:path';
// 保留名判定与 core 权限服务共用同一实现（core 域定义）；本地使用并再导出保持工具层兼容。
import { isReservedMemoryWriteTarget } from '../../../core/domain/permissions/agent-memory-root.js';

export { isReservedMemoryWriteTarget };

// ── 路径判断 ──

/**
 * 判断目标是否位于默认 Auto Memory 根内。
 *
 * @param targetPath - 工具收到的原始目标路径
 * @param memoryDirectory - 当前项目默认记忆根
 * @param workspace - 相对路径的解析基准
 * @returns 目标是否等于记忆根或位于其子树
 */
export function isAutoMemPath(
  targetPath: string,
  memoryDirectory: string | null,
  workspace: string = process.cwd(),
): boolean {
  if (!memoryDirectory) return false;
  return isPathInside(
    resolve(memoryDirectory),
    isAbsolute(targetPath) ? resolve(targetPath) : resolve(workspace, targetPath),
  );
}

/**
 * 判断目标是否位于后台记忆 Agent 被授予的根内。
 *
 * @param targetPath - 工具收到的原始目标路径
 * @param memoryDirectory - 后台 Agent 的唯一可写根
 * @param workspace - 相对路径的解析基准
 * @returns 目标是否位于 Agent 记忆根
 */
export function isAgentMemoryPath(
  targetPath: string,
  memoryDirectory: string | null,
  workspace: string = process.cwd(),
): boolean {
  return isAutoMemPath(targetPath, memoryDirectory, workspace);
}

// ── 权限判定 ──

/** 路径操作类型。 */
export type MemoryOperation = 'read' | 'write' | 'create-directory' | 'delete' | 'move' | 'execute';

/**
 * 对 memory 路径的最终权限决策。
 *
 * - `allow`: 直接放行，不弹审批
 * - `ask`: 进入普通权限流程
 * - `deny`: 硬拒绝
 * - `none`: 不命中此策略（命中 non-memory 路径时返回）
 */
export type MemoryPermissionDecision = 'allow' | 'ask' | 'deny' | 'none';

/**
 * 判断是否应通过 memory-specific 路径放行。
 * 语义与 Claude Code 的 filesystem.ts 对应：
 *   1. 显式 deny/hard cap 先于特例
 *   2. 默认 memory 根的 Read/Edit/Write/createDirectory 在危险目录检查前 allow
 *   3. 删除、移动、执行文件不继承
 *   4. 自定义 memory 根读取 allow，写入走普通流程
 *
 * @param targetPath - 目标路径
 * @param operation - 操作类型
 * @param memoryDirectory - 当前项目默认记忆根（可为 null）
 * @param customMemoryDirectory - 自定义记忆根（可为 null）
 * @param isCustomRoot - 是否使用自定义根
 * @returns 放行决策
 */
export function checkMemoryPermission(
  targetPath: string,
  operation: MemoryOperation,
  memoryDirectory: string | null,
  customMemoryDirectory: string | null = null,
  isCustomRoot = false,
): MemoryPermissionDecision {
  // 删除、移动、执行永远不通过 memory 路径放行
  if (operation === 'delete' || operation === 'move' || operation === 'execute') {
    return 'none';
  }

  // 默认根路径判定
  const activeRoot = isCustomRoot ? customMemoryDirectory : memoryDirectory;
  if (!activeRoot) return 'none';

  if (!isPathInside(resolve(activeRoot), resolve(targetPath))) {
    return 'none';
  }

  // 保留名确定性保护：记忆根内大小写折叠后等于 memory.md 且原形非 MEMORY.md 的写/建目标直接拒绝。
  // 在大小写不敏感文件系统上，memory.md 变体与索引 MEMORY.md 是同一文件，模型将其当作
  // 主题名写入会覆盖索引；原形 MEMORY.md 是索引更新的合法目标，继续走既有放行逻辑。
  if (
    (operation === 'write' || operation === 'create-directory')
    && isReservedMemoryWriteTarget(targetPath, activeRoot)
  ) {
    return 'deny';
  }

  // 默认根：读/写/创建目录直接 allow
  if (!isCustomRoot) {
    if (operation === 'read' || operation === 'write' || operation === 'create-directory') {
      return 'allow';
    }
  }

  // 自定义根：读取 allow，写入走普通流程
  if (isCustomRoot) {
    if (operation === 'read') return 'allow';
    if (operation === 'write' || operation === 'create-directory') return 'ask';
  }

  return 'none';
}

/** 使用路径分段而非字符串前缀判断子树关系。 */
function isPathInside(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === ''
    || (!relation.startsWith('..') && !isAbsolute(relation));
}
