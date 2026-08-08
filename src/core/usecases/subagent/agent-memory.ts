/**
 * @file 子代理持久记忆（subagent-memory）核心模块。
 * 对齐 Claude Code agentMemory.ts 语义：定义级 memory 作用域（user/project/local）解析
 * 为各自基座下的记忆目录，并提供记忆行为提示词构造（buildMemoryPrompt 语义）。
 * 安全边界：类型名必须通过安全校验（防目录逃逸），解析后的目录必须位于作用域基座之内。
 */

import { isAbsolute, relative, resolve } from 'node:path';
import type { ApplicationPaths } from '../../../config/application-paths.js';

/** 子代理记忆作用域：user（跨项目）/ project（随版本控制共享）/ local（本机项目隔离）。 */
export type AgentMemoryScope = 'user' | 'project' | 'local';

/** Windows 保留设备名（大小写不敏感，含扩展名形态仍为设备），禁止用作目录名。 */
const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * 将类型名消毒为可用的目录名：插件命名空间 `:`（Windows 非法）替换为 `-`，
 * 对齐官方 sanitizeAgentTypeForPath。调用方必须先通过 {@link isSafeAgentTypeName} 校验。
 *
 * @param agentType - 子代理类型名
 * @returns 可安全拼接为目录段的名称
 */
export function sanitizeAgentTypeForPath(agentType: string): string {
  return agentType.replace(/:/g, '-');
}

/**
 * 安全名称校验：类型名必须可直接作为单层目录段使用，不得包含路径分隔符、
 * 路径段（`.`/`..`）、绝对路径形态或 Windows 保留设备名（任意扩展形态），
 * 防记忆目录逃逸基座。
 *
 * @param agentType - 子代理类型名（frontmatter name）
 * @returns 名称是否安全
 */
export function isSafeAgentTypeName(agentType: string): boolean {
  if (agentType.trim() === '' || agentType !== agentType.trim()) {
    return false;
  }
  if (agentType.includes('/') || agentType.includes('\\')) {
    return false;
  }
  if (agentType === '.' || agentType === '..') {
    return false;
  }
  // Windows 尾随点/空格会在文件系统上被规范化剥离（'CON.'/'CON ' 均指向设备名），
  // 作为目录段直接拒绝。
  if (/[. ]$/.test(agentType)) {
    return false;
  }
  // Windows 上设备名加任意扩展名仍是设备（CON.txt、NUL.json、COM1.log 等），
  // 按第一个点号前的基名（大写）与保留名表比对。
  const base = agentType.split('.')[0].toUpperCase();
  if (WINDOWS_RESERVED_NAMES.has(base)) {
    return false;
  }
  return true;
}

/**
 * 解析子代理记忆目录绝对路径。
 * user 域位于 `<userConfigDir>/agent-memory/<type>/`；project 域位于
 * `<workspace>/.myagent/agent-memory/<type>/`（可提交配置数据）；local 域位于
 * `<projectDataDir>/agent-memory-local/<type>/`（本机、项目隔离）。
 * 解析后断言目录位于作用域基座之内，逃逸即拒绝（与 {@link isSafeAgentTypeName} 双层防护）。
 *
 * @param agentType - 子代理类型名（需已通过安全校验）
 * @param scope - 记忆作用域
 * @param paths - 应用路径解析结果（提供三域基路径）
 * @returns 记忆目录绝对路径
 * @throws 类型名非法或解析目录越出基座时抛出明确错误
 */
export function getAgentMemoryDir(
  agentType: string,
  scope: AgentMemoryScope,
  paths: ApplicationPaths,
): string {
  if (!isSafeAgentTypeName(agentType)) {
    throw new Error(`子代理类型名不安全，不能用作记忆目录: ${agentType}`);
  }
  const dirName = sanitizeAgentTypeForPath(agentType);
  const base = scope === 'user'
    ? paths.userAgentMemoryBase
    : scope === 'project'
      ? paths.projectAgentMemoryBase
      : paths.localAgentMemoryBase;
  const dir = resolve(base, dirName);
  if (!isPathInside(resolve(base), dir)) {
    throw new Error(`子代理记忆目录越出作用域基座: ${dir}`);
  }
  return dir;
}

/** 各作用域的记忆行为附加说明（对齐官方 scope note 语义）。 */
const SCOPE_NOTES: Record<AgentMemoryScope, string> = {
  user: '- 由于这是 user 作用域的记忆，跨项目通用，请保持学习内容的一般性。',
  project: '- 由于这是 project 作用域的记忆，随版本控制与团队共享，请围绕本项目定制记忆内容。',
  local: '- 由于这是 local 作用域的记忆（不进入版本控制），请围绕本项目与当前机器定制记忆内容。',
};

/**
 * 构造子代理记忆行为提示词段（对齐官方 buildMemoryPrompt 语义）。
 * 包含：作用域说明、记忆目录绝对路径指引、平铺写入两步流程（先写 `<slug>.md`
 * 主题文件并带 frontmatter 三字段 `name`/`description`/`type`（type 四值），
 * 再更新 `MEMORY.md` 索引 `- [Title](<slug>.md) — one-line hook`）、复用/更新规则、
 * 忘记操作顺序与 `memory.md` 保留名禁令。
 *
 * @param scope - 记忆作用域
 * @param memoryDir - 该子代理记忆目录绝对路径
 * @returns 追加到子代理 system prompt 的记忆提示词文本
 */
export function buildAgentMemoryPrompt(
  scope: AgentMemoryScope,
  memoryDir: string,
): string {
  return [
    `## 持久子代理记忆`,
    '',
    `你拥有位于 \`${memoryDir}\` 的持久记忆目录。记忆跨会话保留，请随时间逐步构建，`,
    '使未来会话能复用你对用户、项目与本类型的经验与结论。',
    '',
    '如果用户明确要求记住某事，立即按最匹配的类型保存；要求忘记时，查找并删除对应内容。',
    '',
    SCOPE_NOTES[scope],
    '',
    '### 保存格式与两步流程',
    '',
    '保存一项记忆必须完成以下两步：',
    '',
    '**第一步**：将记忆写入独立的 `<slug>.md` 主题文件（与 `MEMORY.md` 同层平铺）。',
    '文件名必须使用 ASCII kebab-case，匹配 `[a-z0-9]+(?:-[a-z0-9]+)*\\.md`。',
    '主题文件名不得为 `memory.md`（大小写不敏感，与索引 `MEMORY.md` 冲突的保留名）。',
    '每个主题文件都必须使用以下 frontmatter，三个字段均不可省略：',
    '',
    '```markdown',
    '---',
    'name: {{清晰、稳定的主题名称}}',
    'description: {{用于未来判断相关性的一行具体描述}}',
    'type: {{user、feedback、project、reference 四选一}}',
    '---',
    '',
    '{{记忆正文}}',
    '```',
    '',
    '**第二步**：主题文件写入成功后，再向 `MEMORY.md` 添加或更新一行索引：',
    '',
    '```markdown',
    '- [简洁标题](<slug>.md) — 一行相关性摘要',
    '```',
    '',
    '`MEMORY.md` 只是索引，没有 frontmatter，不得直接保存记忆正文。',
    '',
    '### 创建与更新规则',
    '',
    '1. 创建新主题前，先读取 `MEMORY.md` 索引并列举记忆目录，检查是否已有语义相同的主题。',
    '2. 优先复用已有主题，不创建仅名称不同的重复主题。',
    '3. 更新主题正文时同步维护其 `name`、`description` 和 `type`。',
    '4. 新建主题时先写主题文件（事实源），再更新 `MEMORY.md` 索引。',
    '5. 写入或编辑主题后，必须重新读取结果，确认 frontmatter 完整、类型合法，再更新索引。',
    '',
    '### 忘记操作',
    '',
    '- **忘记单项内容**：先编辑主题正文删除该内容，再按需更新索引摘要；主题仍含有效内容时保留文件。',
    '- **忘记整个主题**：先删除主题文件（`<slug>.md`），再删除 `MEMORY.md` 中对应的索引项。',
    '- 从当前回合起停止依赖已被要求忘记的内容。',
    '',
    '### 使用规范',
    '',
    '- 使用标准文件工具（读取、列举、写入、编辑、删除）维护记忆文件，它们须经过路径授权与审计。',
    `- 读写记忆必须使用上述绝对目录 \`${memoryDir}\`，不要把相对路径解析到工作区。`,
  ].join('\n');
}

/** 使用路径分段判断候选路径是否位于指定根内。 */
function isPathInside(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === ''
    || (!relation.startsWith('..') && !isAbsolute(relation));
}
