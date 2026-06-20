/**
 * 核心上下文加载器模块。
 * 负责从物理磁盘中动态加载并缓存全局规则、项目局部规则和扩展沙盒技能。
 */

import { existsSync, readFileSync, readdirSync, lstatSync, watch, statSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';

// 开发环境硬编码路径，用于获取各项规则和技能
const DEV_GLOBAL_RULES_PATH = 'D:\\Projects\\MyAgent\\.agent\\global_rules.md';
const DEV_LOCAL_RULES_PATH = 'D:\\Projects\\MyAgent\\.agent\\rules\\guize.md';
const DEV_SKILLS_DIR = 'D:\\Projects\\MyAgent\\.agent\\skills';

// 设定单文件最大加载为 20KB (20480 字节)，防止 Token 溢出
const RULE_MAX_BYTES = 20480;

/**
 * 安全地读取规则文件，若文件过大则进行物理截断并拼入标志语（Token 防爆熔断）。
 *
 * @param filePath - 待读取的规则文件路径
 * @returns 截断后或完整的规则内容
 */
function readAndLimitFile(filePath: string): string {
  try {
    if (!existsSync(filePath)) {
      return '';
    }
    const stat = statSync(filePath);
    const rawContent = readFileSync(filePath, 'utf-8').trim();
    
    // 熔断拦截逻辑
    if (stat.size > RULE_MAX_BYTES) {
      const truncated = rawContent.slice(0, RULE_MAX_BYTES);
      return `${truncated}\n\n[...系统规则过长，已被安全模块截断，仅保留前20KB...]`;
    }
    return rawContent;
  } catch (e) {
    console.warn(`[ContextLoader] 安全读取规则文件失败: ${filePath}, 错误: ${e}`);
    return '';
  }
}

/**
 * 加载全局规则 (Global Rules)。
 * 
 * @returns 成功读取时返回全局规则内容的字符串，否则返回空字符串
 */
export function loadGlobalRules(): string {
  return readAndLimitFile(DEV_GLOBAL_RULES_PATH);
}

/**
 * 加载局部/工作区规则 (Local Rules)。
 * 
 * @returns 成功读取时返回局部规则内容的字符串，否则返回空字符串
 */
export function loadLocalRules(): string {
  return readAndLimitFile(DEV_LOCAL_RULES_PATH);
}

/**
 * 技能元数据接口
 * 描述了一个扩展技能的基本信息与文件路径，不包含臃肿的正文。
 */
export interface SkillMetadata {
  name: string;
  description: string;
  filePath: string;
}

// 模块级缓存池，用于在内存中长期保存技能索引，避免反复查盘
const skillsCache = new Map<string, SkillMetadata>();
// 标识位，用于判断是否已经启动了后台监听服务
let isWatching = false;

/**
 * 使用 gray-matter 剥离并解析文件中的 YAML Frontmatter 元数据。
 * 
 * @param content - 包含 YAML 头部和 Markdown 正文的原始文件内容
 * @returns 提取出名称、描述和纯净的正文主体
 */
function parseSkillFrontmatter(content: string): { name: string, description: string, body: string } {
  try {
    const parsed = matter(content);
    return {
      name: typeof parsed.data.name === 'string' ? parsed.data.name : 'unknown',
      description: typeof parsed.data.description === 'string' ? parsed.data.description : '',
      body: parsed.content.trim()
    };
  } catch (e) {
    console.warn(`[ContextLoader] gray-matter 解析失败: ${e}`);
    return { name: 'unknown', description: '', body: content.trim() };
  }
}

/**
 * 递归寻找指定目录下的所有 SKILL.md 文件，自带层级保护与防死循环机制。
 * 
 * @param dir - 需要遍历的目标目录路径
 * @param fileList - 收集结果的文件路径数组引用（默认值为空数组）
 * @param currentDepth - 当前遍历的深度级别（默认值为 1）
 * @param maxDepth - 允许向下遍历的最大深度上限（默认值为 3）
 * @returns 返回所有找到的 SKILL.md 的完整绝对路径数组
 */
function findSkillFiles(dir: string, fileList: string[] = [], currentDepth: number = 1, maxDepth: number = 3): string[] {
  // 如果达到最大深度或者目录本身不存在，立刻回溯
  if (currentDepth > maxDepth || !existsSync(dir)) return fileList;

  try {
    const files = readdirSync(dir);
    for (const file of files) {
      const fullPath = join(dir, file);
      try {
        const stat = lstatSync(fullPath);
        // 跳过符号链接文件，以此阻断在一些错误配置下可能产生的死循环
        if (stat.isSymbolicLink()) continue; 
        
        if (stat.isDirectory()) {
          // 对子目录继续递归
          findSkillFiles(fullPath, fileList, currentDepth + 1, maxDepth);
        } else if (file.toLowerCase() === 'skill.md') {
          // 匹配文件名并加入集合
          fileList.push(fullPath);
        }
      } catch (err) {
        // 捕获可能产生的权限异常，并打印调试日志，防止后续排查时无迹可寻
        console.warn(`[ContextLoader] 访问文件状态失败 (可能由于权限问题跳过), 路径: ${fullPath}`, err);
      }
    }
  } catch (err) {
    // 捕获目录读取层面的异常并打印日志，防止整个扫描流程崩溃
    console.warn(`[ContextLoader] 遍历技能目录失败, 路径: ${dir}`, err);
  }
  return fileList;
}

/**
 * 主动扫描文件系统并刷新内存中的技能索引缓存
 * 该方法会清空现有缓存池并从磁盘重构状态。
 */
export function refreshSkillsCache(): void {
  const skillFiles = findSkillFiles(DEV_SKILLS_DIR);
  skillsCache.clear();

  for (const file of skillFiles) {
    try {
      const rawContent = readFileSync(file, 'utf-8');
      const parsed = parseSkillFrontmatter(rawContent);
      // 只缓存必要的元数据，坚决不缓存 Markdown 正文以防内存溢出
      if (parsed.name !== 'unknown') {
        skillsCache.set(parsed.name, {
          name: parsed.name,
          description: parsed.description,
          filePath: file
        });
      }
    } catch (e) {
      console.warn(`[ContextLoader] 缓存技能文件失败: ${file}, 错误: ${e}`);
    }
  }
}

/**
 * 初始化后台异步监听服务（Watcher）
 * 在第一次请求索引时懒加载调用，保证文件系统发生变动时能够触发缓存的自动刷新。
 */
export function initSkillsWatcher(): void {
  // 保证只会启动一次监听
  if (isWatching) return;
  
  refreshSkillsCache();
  
  try {
    if (existsSync(DEV_SKILLS_DIR)) {
      watch(DEV_SKILLS_DIR, { recursive: true }, () => {
        // 文件一旦有任何变更，简单粗暴地触发缓存全量刷新
        refreshSkillsCache();
      });
      isWatching = true;
    }
  } catch (e) {
    console.warn(`[ContextLoader] 技能监听初始化失败: ${e}`);
  }
}

/**
 * 极速获取所有已安装技能的索引列表，支持针对 Watcher 的惰性初始化。
 * 
 * @returns 返回纯净的技能元数据数组
 */
export function loadSkills(): SkillMetadata[] {
  if (!isWatching) {
    initSkillsWatcher();
  }
  // 将内存中 Map 的值转为数组快速抛出
  return Array.from(skillsCache.values());
}

/**
 * 懒加载获取特定技能的完整 Markdown 内容。
 * 该方法仅在当前会话明确需要某技能（例如工具被调用）时才会真正发生磁盘 I/O。
 * 
 * @param name - 待拉取详情的技能名称
 * @returns 成功读取并解析后返回技能的纯正文内容，若找不到或出错则返回 null
 */
export function loadSkillContent(name: string): string | null {
  const meta = skillsCache.get(name);
  if (!meta) return null;
  
  try {
    if (existsSync(meta.filePath)) {
      const rawContent = readFileSync(meta.filePath, 'utf-8');
      const parsed = parseSkillFrontmatter(rawContent);
      return parsed.body;
    }
  } catch (e) {
    console.warn(`[ContextLoader] 按需读取技能全文失败: ${name}, 错误: ${e}`);
  }
  return null;
}
