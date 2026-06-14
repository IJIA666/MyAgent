import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { dirname } from 'path';
import { secureResolvePath } from './base.js';

/**
 * 记录 readFileTool 读取快照的内存字典，用于实现基于 mtime 的缓存拦截去重机制。
 * 键为文件绝对路径，值为对应的快照记录。
 */
export const readFileState = new Map<string, { lineStart?: number; lineEnd?: number; mtimeMs: number }>();

/**
 * 文件读取适配封装组件。
 * 支持可选的 lineStart 和 lineEnd 参数来实现指定行号区间（从 1 开始计数，闭区间）的精读。
 * 
 * @param targetPath 请求读取的数据节点路径
 * @param lineStart 起始行（可选，从 1 开始）
 * @param lineEnd 结束行（可选，包含该行）
 * @returns 解析得到的纯文本数据集
 */
export function readFileTool(targetPath: string, lineStart?: number, lineEnd?: number): string {
  // 获取已脱敏的请求资源定位符
  const safePath = secureResolvePath(targetPath);

  // 检查目标资产的存在性
  if (!existsSync(safePath)) {
    throw new Error(`未找到文件："${targetPath}"`);
  }

  const fileStat = statSync(safePath);
  // 实施资产类别约束（规避将目录资源视作标准文件而引发的读取层级瘫痪）
  if (fileStat.isDirectory()) {
    throw new Error(`路径 "${targetPath}" 是一个目录，不能作为普通文本文件进行读取。`);
  }

  const currentMtimeMs = fileStat.mtimeMs;
  const cachedState = readFileState.get(safePath);

  // 校验拦截逻辑：只有完全相同的读取范围且文件未被修改时才拦截
  if (
    cachedState &&
    cachedState.lineStart === lineStart &&
    cachedState.lineEnd === lineEnd &&
    cachedState.mtimeMs === currentMtimeMs
  ) {
    return "File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.";
  }

  // 输出序列化文件流
  const content = readFileSync(safePath, 'utf-8');

  let resultText: string;
  // 若均未指定行范围，则返回全量文件文本
  if (lineStart === undefined && lineEnd === undefined) {
    resultText = content;
  } else {
    // 按行切分，兼容不同平台的换行符
    const lines = content.split(/\r?\n/);
    const totalLines = lines.length;

    const start = lineStart !== undefined ? Math.max(1, lineStart) : 1;
    const end = lineEnd !== undefined ? Math.min(totalLines, lineEnd) : totalLines;

    if (start > totalLines) {
      resultText = `[提示：起始行 ${start} 超过了文件的总行数 ${totalLines}]`;
    } else if (end < start) {
      throw new Error(`结束行 lineEnd (${end}) 必须大于或等于起始行 lineStart (${start})`);
    } else {
      // 转换 1-indexed 到 0-indexed 进行切片
      const sliceStart = start - 1;
      const sliceEnd = end;
      const slicedLines = lines.slice(sliceStart, sliceEnd);

      // 组装带有行范围说明的头部前缀
      const prefix = `[文件：${targetPath} 第 ${start} 至 ${end} 行，总共 ${totalLines} 行]\n`;
      resultText = prefix + slicedLines.join('\n');
    }
  }

  // 记录本次成功读取的快照到内存字典
  readFileState.set(safePath, { lineStart, lineEnd, mtimeMs: currentMtimeMs });

  return resultText;
}

/**
 * 文件变更适配封装组件。
 * 提供幂等的更新体验：新建不存在的节点、全量覆盖已存在的节点，并保障父目录结构的完整性。
 * 
 * @param targetPath 计划落盘的数据节点路径
 * @param content 带持久化要求的负载文本内容
 * @returns 更新操作确认标识
 */
export function writeFileTool(targetPath: string, content: string): string {
  // 获取已脱敏的请求资源定位符
  const safePath = secureResolvePath(targetPath);

  // 对目录链条进行检查与前置构建
  const parentDir = dirname(safePath);
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  // 将变动执行至存储设备
  writeFileSync(safePath, content, 'utf-8');

  return `写入执行成功："${targetPath}"。`;
}

/**
 * 目录查询检索组件。
 * 提供获取授权沙箱内指定目录浅层列表清单的能力。
 * 
 * @param targetPath 指定查询层级的节点坐标
 * @returns 包含各子元素名称的有序集合
 */
export function listFilesTool(targetPath: string = '.'): string[] {
  // 获取已脱敏的请求资源定位符
  const safePath = secureResolvePath(targetPath);

  // 检查目标资产的存在性
  if (!existsSync(safePath)) {
    throw new Error(`未找到文件夹："${targetPath}"`);
  }

  // 实施资产类别约束（阻止面向单文件发起的无效检索请求）
  if (!statSync(safePath).isDirectory()) {
    throw new Error(`路径 "${targetPath}" 是一个文件，不能作为文件夹列出。`);
  }

  // 输出资源清单
  return readdirSync(safePath);
}
