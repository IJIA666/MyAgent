import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';

/**
 * 核心上下文加载器
 * 负责从文件系统中动态加载全局规则、局部规则和扩展技能。
 * 目前配置为开发沙盒路径以防污染用户真实目录。
 */

const DEV_GLOBAL_RULES_PATH = 'D:\\Projects\\MyAgent\\.agent\\global_rules.md';
const DEV_LOCAL_RULES_PATH = 'D:\\Projects\\MyAgent\\.agent\\rules\\guize.md';
const DEV_SKILLS_DIR = 'D:\\Projects\\MyAgent\\.agent\\skills';

/**
 * 加载全局规则 (Global Rules)
 * @returns 规则文件内容或空字符串
 */
export function loadGlobalRules(): string {
  if (existsSync(DEV_GLOBAL_RULES_PATH)) {
    try {
      return readFileSync(DEV_GLOBAL_RULES_PATH, 'utf-8').trim();
    } catch (e) {
      console.warn(`[ContextLoader] 读取全局规则失败: ${e}`);
    }
  }
  return '';
}

/**
 * 加载局部/工作区规则 (Local Rules)
 * @returns 规则文件内容或空字符串
 */
export function loadLocalRules(): string {
  if (existsSync(DEV_LOCAL_RULES_PATH)) {
    try {
      return readFileSync(DEV_LOCAL_RULES_PATH, 'utf-8').trim();
    } catch (e) {
      console.warn(`[ContextLoader] 读取局部规则失败: ${e}`);
    }
  }
  return '';
}

export interface Skill {
  name: string;
  description: string;
  content: string;
}

/**
 * 使用 gray-matter 剥离并解析 YAML Frontmatter
 * @param content 原始文本
 * @returns 剥离后的文本及元数据
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
 * 递归寻找目录下的所有 SKILL.md
 */
function findSkillFiles(dir: string, fileList: string[] = []): string[] {
  if (!existsSync(dir)) return fileList;

  const files = readdirSync(dir);
  for (const file of files) {
    const fullPath = join(dir, file);
    if (statSync(fullPath).isDirectory()) {
      findSkillFiles(fullPath, fileList);
    } else if (file.toUpperCase() === 'SKILL.md') {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

/**
 * 加载并聚合所有技能 (Skills)
 * @returns 解析好的技能列表
 */
export function loadSkills(): Skill[] {
  const skillFiles = findSkillFiles(DEV_SKILLS_DIR);
  if (skillFiles.length === 0) {
    return [];
  }

  const skills: Skill[] = [];

  for (const file of skillFiles) {
    try {
      const rawContent = readFileSync(file, 'utf-8');
      const parsed = parseSkillFrontmatter(rawContent);
      if (parsed.body) {
        skills.push({
          name: parsed.name,
          description: parsed.description,
          content: parsed.body
        });
      }
    } catch (e) {
      console.warn(`[ContextLoader] 读取技能文件失败: ${file}, 错误: ${e}`);
    }
  }

  return skills;
}
