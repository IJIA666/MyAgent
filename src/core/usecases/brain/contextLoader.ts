/**
 * 核心上下文加载器工具模块。
 * 负责从物理磁盘中安全读取全局规则、项目局部规则和扩展沙盒技能文件，不持有全局状态与缓存。
 */

import { existsSync, readFileSync, readdirSync, lstatSync, statSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';
import { logger } from '../../../utils/logger.js'; // 导入统一日志单例 logger

// 设定单文件最大加载为 20KB (20480 字节)，防止 Token 溢出
const RULE_MAX_BYTES = 20480;

/**
 * 技能元数据接口
 * 描述了一个扩展技能的基本信息与文件路径，不包含臃肿的正文。
 */
export interface SkillMetadata {
  name: string;
  description: string;
  filePath: string;
}

/**
 * 安全地读取规则文件，若文件过大则进行物理截断并拼入标志语（Token 防爆熔断）。
 *
 * @param filePath - 待读取的规则文件路径
 * @returns 截断后或完整的规则内容
 */
export function readAndLimitFile(filePath: string): string {
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
    logger.warn(`[ContextLoader] 安全读取规则文件失败: ${filePath}, 错误: ${e}`);
    return '';
  }
}

/**
 * 加载用户级规则（来自用户 rules 目录下的全部 `.md` 文件）。
 *
 * @param userRulesDir - 用户 rules 目录绝对路径
 * @returns 合并后的用户规则内容；目录不存在返回空字符串
 */
export function loadUserRules(userRulesDir: string): string {
  return loadRulesFromDir(userRulesDir);
}

/**
 * 加载项目级规则（来自项目 rules 目录下的全部 `.md` 文件）。
 *
 * @param projectRulesDir - 项目 rules 目录绝对路径
 * @returns 合并后的项目规则内容；目录不存在返回空字符串
 */
export function loadProjectRules(projectRulesDir: string): string {
  return loadRulesFromDir(projectRulesDir);
}

/**
 * 从指定目录中加载全部 `.md` 规则文件，按稳定顺序合并。
 *
 * @param dir - 规则目录绝对路径
 * @returns 合并后的规则内容
 */
function loadRulesFromDir(dir: string): string {
  try {
    if (!existsSync(dir)) {
      return '';
    }
    const files = readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .sort();

    const parts: string[] = [];
    for (const file of files) {
      const content = readAndLimitFile(join(dir, file));
      if (content) {
        parts.push(content);
      }
    }
    return parts.join('\n\n');
  } catch {
    return '';
  }
}

/**
 * 扫描用户和项目两个技能目录，合并技能列表。
 * 同名技能以项目级定义覆盖用户级定义。
 *
 * @param userSkillsDir - 用户 skills 目录绝对路径
 * @param projectSkillsDir - 项目 skills 目录绝对路径
 * @returns 合并后的技能元数据数组
 */
export function scanSkills(userSkillsDir: string, projectSkillsDir: string): SkillMetadata[] {
  const userSkills = scanSkillsFromDir(userSkillsDir);
  const projectSkills = scanSkillsFromDir(projectSkillsDir);

  // 项目技能覆盖同名用户技能
  const merged = new Map<string, SkillMetadata>();
  for (const skill of userSkills) {
    merged.set(skill.name, skill);
  }
  for (const skill of projectSkills) {
    merged.set(skill.name, skill);
  }
  return Array.from(merged.values());
}

/**
 * 使用 gray-matter 剥离并解析文件中的 YAML Frontmatter 元数据。
 * 
 * @param content - 包含 YAML 头部和 Markdown 正文的原始文件内容
 * @returns 提取出名称、描述和纯净的正文主体
 */
export function parseSkillFrontmatter(content: string): { name: string, description: string, body: string } {
  try {
    const parsed = matter(content);
    return {
      name: typeof parsed.data.name === 'string' ? parsed.data.name : 'unknown',
      description: typeof parsed.data.description === 'string' ? parsed.data.description : '',
      body: parsed.content.trim()
    };
  } catch (e) {
    logger.warn(`[ContextLoader] gray-matter 解析失败: ${e}`);
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
export function findSkillFiles(dir: string, fileList: string[] = [], currentDepth: number = 1, maxDepth: number = 3): string[] {
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
        logger.warn(`[ContextLoader] 访问文件状态失败 (可能由于权限问题跳过), 路径: ${fullPath}`, err);
      }
    }
  } catch (err) {
    logger.warn(`[ContextLoader] 遍历技能目录失败, 路径: ${dir}`, err);
  }
  return fileList;
}

/**
 * 从单个目录扫描并解析技能文件。
 *
 * @param dir - 技能目录绝对路径
 * @returns 解析出的技能元数据数组
 */
function scanSkillsFromDir(dir: string): SkillMetadata[] {
  try {
    if (!existsSync(dir)) {
      return [];
    }
    const skillFiles = findSkillFiles(dir);
    const list: SkillMetadata[] = [];

    for (const file of skillFiles) {
      try {
        const rawContent = readFileSync(file, 'utf-8');
        const parsed = parseSkillFrontmatter(rawContent);
        if (parsed.name !== 'unknown') {
          list.push({
            name: parsed.name,
            description: parsed.description,
            filePath: file
          });
        }
      } catch (e) {
        logger.warn(`[ContextLoader] 解析技能文件失败: ${file}, 错误: ${e}`);
      }
    }
    return list;
  } catch {
    return [];
  }
}

/**
 * 读取特定技能文件的完整 Markdown 正文内容。
 * 
 * @param filePath - 技能文件的物理路径
 * @returns 技能的纯正文内容，若找不到或读取出错则返回 null
 */
export function readSkillContent(filePath: string): string | null {
  try {
    if (existsSync(filePath)) {
      const rawContent = readFileSync(filePath, 'utf-8');
      const parsed = parseSkillFrontmatter(rawContent);
      return parsed.body;
    }
  } catch (e) {
    logger.warn(`[ContextLoader] 读取技能全文失败: ${filePath}, 错误: ${e}`);
  }
  return null;
}
