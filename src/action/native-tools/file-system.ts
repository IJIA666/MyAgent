/**
 * 本地文件系统原子操作工具集。
 * 提供路径安全校验约束下的文本读取（支持行范围精读）、文件写入、特征匹配增量编辑以及目录清单列举功能。
 */

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
 * 基于纯文本特征匹配的文件增量修改组件。
 * 提供更安全的局部文件编辑能力，规避传统基于行号机制带来的内容漂移及破坏风险。
 * 
 * @param targetPath 计划编辑的数据节点路径
 * @param old_string 需要被替换的原始特征文本
 * @param new_string 用于替换的新文本
 * @param replace_all 是否允许全局替换所有匹配到的 old_string。默认为 false（要求唯一匹配）。
 * @returns 增量编辑操作确认标识
 */
export function editFileTool(
  targetPath: string,
  old_string: string,
  new_string: string,
  replace_all: boolean = false
): string {
  // 基础参数校验
  if (old_string === new_string) {
    throw new Error("没有任何实质性修改：old_string 和 new_string 完全相同。");
  }
  if (!old_string) {
    throw new Error("old_string 不能为空。如果希望创建或全量覆盖文件，请使用 writeFileTool。");
  }

  // 获取已脱敏的请求资源定位符
  const safePath = secureResolvePath(targetPath);

  // 检查目标资产的存在性
  if (!existsSync(safePath)) {
    throw new Error(`未找到文件："${targetPath}"，编辑失败。`);
  }

  const fileStat = statSync(safePath);
  if (fileStat.isDirectory()) {
    throw new Error(`路径 "${targetPath}" 是一个目录，不能进行文本编辑。`);
  }

  // 强制前置校验：必须先阅读过该文件才能进行局部修改
  if (!readFileState.has(safePath)) {
    throw new Error(`拒绝安全风险操作：在修改已有文件前，必须先调用 readFile 工具阅读该文件的最新内容。`);
  }

  // 加载原始文件文本
  const content = readFileSync(safePath, 'utf-8');

  // 计算匹配次数
  let replacementsCount = 0;
  let offset = 0;
  while ((offset = content.indexOf(old_string, offset)) !== -1) {
    replacementsCount++;
    offset += old_string.length;
  }

  // 安全拦截：未找到匹配的字符串
  if (replacementsCount === 0) {
    throw new Error(
      `未找到匹配的 old_string。请确认文件最新内容（是否已在别处被修改），以及空格、缩进或换行是否完全一致。`
    );
  }

  // 安全拦截：匹配多处但不允许全部替换
  if (replacementsCount > 1 && !replace_all) {
    throw new Error(
      `在文件中找到了 ${replacementsCount} 处完全相同的 old_string 匹配。无法确认要替换的准确位置。请提供包含更多前后文的 old_string 以确保唯一性，或者如果确定要全部替换，请设置 replace_all 为 true。`
    );
  }

  // 执行文本替换逻辑
  const newContent = replace_all
    ? content.split(old_string).join(new_string)
    : content.replace(old_string, new_string);

  // 将变动持久化至存储设备
  writeFileSync(safePath, newContent, 'utf-8');

  return `文件局部修改成功："${targetPath}"。共替换了 ${replacementsCount} 处。`;
}

/**
 * 文件全量写入/创建适配封装组件。
 * 仅用于创建新节点或必须进行全文件覆盖的场景。对于已有文件的局部增量修改，请优先使用 editFileTool。
 * 
 * @param targetPath 计划落盘的数据节点路径
 * @param content 带持久化要求的负载文本内容
 * @returns 更新操作确认标识
 */
export function writeFileTool(targetPath: string, content: string): string {
  // 获取已脱敏的请求资源定位符
  const safePath = secureResolvePath(targetPath);

  // 强制前置校验：如果文件已存在，为了避免恶意全量覆盖，必须先阅读过该文件
  if (existsSync(safePath) && !readFileState.has(safePath)) {
    throw new Error(`拒绝安全风险操作：您正在尝试全量覆盖一个已有文件。为了防止代码误毁，在覆盖前必须先调用 readFile 工具阅读该文件的最新内容。`);
  }

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
