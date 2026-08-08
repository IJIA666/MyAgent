/**
 * @file 子代理持久记忆根判定（core 域，供权限服务与工具层共用）。
 * 从 memory-path-policy 迁入的纯路径判定：无 IO、无宿主依赖，保证 core 权限服务
 * 不反向依赖 adapters 层。
 */

import { isAbsolute, relative, resolve } from 'node:path';

/**
 * 判断写/建目标是否为记忆根内的保留名变体。
 * 仅当目标位于 memoryRoot 之内，且 basename 大小写折叠后等于 `memory.md`、原形字符串不等于
 * `MEMORY.md` 时返回 true。原形 `MEMORY.md`（索引更新）放行；`memory.md`/`Memory.md` 等
 * 变体（意图建主题）拒绝。目标位于记忆根之外（如工作区普通目录的 memory.md）时返回 false，
 * 不误伤非记忆文件。
 * 工具层（file-system/directory-manager/apply-patch）与权限服务共用，保证同一判定逻辑。
 *
 * @param targetPath - 工具收到的原始目标路径（绝对或相对）
 * @param memoryRoot - 记忆根绝对路径；未启用记忆（null/空）时不做任何拦截
 * @returns 目标是否位于记忆根内且为保留名变体
 */
export function isReservedMemoryWriteTarget(
  targetPath: string,
  memoryRoot: string | null | undefined,
): boolean {
  if (!memoryRoot) {
    return false;
  }
  if (!isPathInside(resolve(memoryRoot), resolve(targetPath))) {
    return false;
  }
  const basename = targetPath.split(/[\\/]/).pop() ?? '';
  return basename.toLowerCase() === 'memory.md' && basename !== 'MEMORY.md';
}

/** 使用路径分段判断候选路径是否位于指定根内。 */
export function isPathInside(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === ''
    || (!relation.startsWith('..') && !isAbsolute(relation));
}
