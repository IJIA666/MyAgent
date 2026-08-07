/**
 * 统一的应用路径解析组件。
 * 在授权 workspace 确认后一次性解析全部项目配置路径、用户配置路径和项目运行数据路径，
 * 生成不可变的 {@link ApplicationPaths} 对象。
 * 所有持久化消费者必须使用该对象，不得自行拼装 `.agent`、`.myagent`、`process.cwd()` 或 `homedir()` 路径。
 */

import { resolve } from 'path';
import { accessSync, constants, existsSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { homedir } from 'os';

/** workspace 配置目录名称常量。 */
const PROJECT_CONFIG_DIR = '.myagent';
/** 用户应用数据根下用于存放用户配置的目录名。 */
const USER_CONFIG_DIR = '.myagent';
/** 用户应用数据根下用于存放项目运行数据的目录名。 */
const PROJECTS_DIR = 'projects';

/**
 * 不可变的应用路径集合。
 * 所有路径均为规范化绝对路径，由 {@link createApplicationPaths} 一次性构造。
 */
export interface ApplicationPaths {
  /** 规范化后的授权 workspace 绝对路径。 */
  readonly workspace: string;
  /** 当前 workspace 的唯一稳定标识：`<sanitized-basename>-<sha256-prefix>`。 */
  readonly workspaceKey: string;
  /** 用户应用数据根目录（默认为 `~/.myagent`，测试可注入）。 */
  readonly userAppDataRoot: string;

  // ── 项目配置路径（位于 workspace .myagent 下，可提交） ──
  /** 项目 settings 目录：`<workspace>/.myagent/`。 */
  readonly projectConfigDir: string;
  /** 项目 settings.json。 */
  readonly projectSettingsPath: string;
  /** 项目 settings.local.json。 */
  readonly projectLocalSettingsPath: string;
  /** 项目 rules 目录。 */
  readonly projectRulesDir: string;
  /** 项目 skills 目录。 */
  readonly projectSkillsDir: string;
  /** 项目子代理定义目录：`<projectConfigDir>/agents/`，存放 `.md` 子代理定义。 */
  readonly projectAgentsDir: string;

  // ── 用户配置路径（位于 ~/.myagent 下） ──
  /** 用户 settings 目录。 */
  readonly userConfigDir: string;
  /** 用户 settings.json。 */
  readonly userSettingsPath: string;
  /** 用户 rules 目录。 */
  readonly userRulesDir: string;
  /** 用户 skills 目录。 */
  readonly userSkillsDir: string;
  /** 用户子代理定义目录：`<userConfigDir>/agents/`，存放 `.md` 子代理定义（跨项目可用）。 */
  readonly userAgentsDir: string;

  // ── Skill 生命周期元数据路径（位于 ~/.myagent 下，不入 workspace） ──
  /**
   * Skill 使用遥测 sidecar 路径：`<userConfigDir>/skills/.usage.json`。
   * 记录 agent-created 标记、查看/使用/修改计数、active/stale/archived 状态。
   */
  readonly skillUsagePath: string;
  /**
   * Skill 归档目录：`<userConfigDir>/skills/.archive/`。
   * Curator 归档的完整 Skill 包移入此处，支持 restore 恢复。
   */
  readonly skillArchiveDir: string;
  /**
   * Skill 写入暂存批准记录目录：`<userConfigDir>/pending/skills/`。
   * writeApproval=true 时 skill_manage 的调用暂存于此，待用户批准或拒绝。
   */
  readonly skillPendingDir: string;
  /**
   * Curator 调度状态路径：`<userConfigDir>/skills/.curator-state.json`。
   * 持久化 lastRunAt、lastActivityAt、paused 和最近报告 id。
   */
  readonly skillCuratorStatePath: string;
  /**
   * Curator 运行前备份目录：`<userConfigDir>/skills/.curator-backups/`。
   * 每次真实变更运行前备份活动 Skill、archive 和生命周期元数据。
   */
  readonly skillCuratorBackupsDir: string;
  /**
   * Curator 运行日志目录：`<userConfigDir>/logs/curator/`。
   * 每次运行写入 run.json 与 REPORT.md，区分 transitions/consolidations/prunings/kept/failed。
   */
  readonly skillCuratorLogsDir: string;

  // ── 当前项目运行数据路径（位于 ~/.myagent/projects/<workspace-key>/ 下） ──
  /** 当前项目的运行数据根目录。 */
  readonly projectDataDir: string;

  /**
   * 长期记忆目录：`<project-data>/memory/`。
   * 采用 Markdown-first 项目私有长期记忆，以 MEMORY.md 为索引、同层平铺 *.md 为主题正文。
   */
  readonly memoryDir: string;

  /** 日志目录：`<project-data>/logs/`。 */
  readonly logsDir: string;
  /** 运行日志文件：`<logsDir>/run.log`。 */
  readonly runLogPath: string;
  /** trace 目录：`<logsDir>/traces/`。 */
  readonly tracesDir: string;
  /** audit 目录：`<logsDir>/audits/`。 */
  readonly auditsDir: string;

  /** 持久状态目录：`<project-data>/state/`。 */
  readonly stateDir: string;
  /** 会话快照目录：`<stateDir>/sessions/`。 */
  readonly sessionsDir: string;
  /** 子代理 transcript 目录：`<stateDir>/subagents/`，与主会话快照隔离。 */
  readonly subagentsDir: string;
  /** 浏览器状态目录：`<stateDir>/browser/`。 */
  readonly browserDir: string;

  /** 产物目录：`<project-data>/artifacts/`。 */
  readonly artifactsDir: string;
  /** 工具输出目录：`<artifactsDir>/tool-outputs/`。 */
  readonly toolOutputsDir: string;
  /** 截图目录：`<artifactsDir>/screenshots/`。 */
  readonly screenshotsDir: string;

  /** 临时数据目录：`<project-data>/tmp/`。 */
  readonly tmpDir: string;
  /** 回滚备份目录：`<tmpDir>/backups/`。 */
  readonly backupsDir: string;
  /** Skill 写入协作锁目录：`<userConfigDir>/.locks/skills/`。 */
  readonly skillLocksDir: string;
}

/** {@link createApplicationPaths} 的选项。 */
export interface ApplicationPathsOptions {
  /** 用户主目录，默认使用 {@link homedir}。测试必须注入临时根。 */
  userHome?: string;
  /** 显式应用数据根，不为空时覆盖 `userHome` 的拼接结果。 */
  appDataRoot?: string;
}

/**
 * 创建不可变的 {@link ApplicationPaths}。
 *
 * @param workspace - 已由 {@link loadConfig} 规范化的授权 workspace 绝对路径。
 * @param options - 可选的应用数据根配置。
 * @returns 冻结的 ApplicationPaths 对象。
 * @throws 当 workspace 为空、相对路径或应用数据根无法创建时抛出明确错误。
 */
export function createApplicationPaths(
  workspace: string,
  options: ApplicationPathsOptions = {},
): ApplicationPaths {
  validateWorkspace(workspace);

  const { userHome = homedir(), appDataRoot } = options;
  const resolvedDataRoot = appDataRoot
    ? resolve(appDataRoot)
    : resolve(userHome, USER_CONFIG_DIR);

  const workspaceKey = computeWorkspaceKey(workspace);

  const projectConfigDir = resolve(workspace, PROJECT_CONFIG_DIR);
  const userConfigDir = resolvedDataRoot;
  const projectDataDir = resolve(resolvedDataRoot, PROJECTS_DIR, workspaceKey);

  const paths: ApplicationPaths = {
    workspace,
    workspaceKey,
    userAppDataRoot: resolvedDataRoot,

    // 项目配置
    projectConfigDir,
    projectSettingsPath: resolve(projectConfigDir, 'settings.json'),
    projectLocalSettingsPath: resolve(projectConfigDir, 'settings.local.json'),
    projectRulesDir: resolve(projectConfigDir, 'rules'),
    projectSkillsDir: resolve(projectConfigDir, 'skills'),
    projectAgentsDir: resolve(projectConfigDir, 'agents'),

    // 用户配置
    userConfigDir,
    userSettingsPath: resolve(userConfigDir, 'settings.json'),
    userRulesDir: resolve(userConfigDir, 'rules'),
    userSkillsDir: resolve(userConfigDir, 'skills'),
    userAgentsDir: resolve(userConfigDir, 'agents'),

    // Skill 生命周期元数据
    skillUsagePath: resolve(userConfigDir, 'skills', '.usage.json'),
    skillArchiveDir: resolve(userConfigDir, 'skills', '.archive'),
    skillPendingDir: resolve(userConfigDir, 'pending', 'skills'),
    skillCuratorStatePath: resolve(userConfigDir, 'skills', '.curator-state.json'),
    skillCuratorBackupsDir: resolve(userConfigDir, 'skills', '.curator-backups'),
    skillCuratorLogsDir: resolve(userConfigDir, 'logs', 'curator'),

    // 项目运行数据
    projectDataDir,
    memoryDir: resolve(projectDataDir, 'memory'),
    logsDir: resolve(projectDataDir, 'logs'),
    runLogPath: resolve(projectDataDir, 'logs', 'run.log'),
    tracesDir: resolve(projectDataDir, 'logs', 'traces'),
    auditsDir: resolve(projectDataDir, 'logs', 'audits'),
    stateDir: resolve(projectDataDir, 'state'),
    sessionsDir: resolve(projectDataDir, 'state', 'sessions'),
    subagentsDir: resolve(projectDataDir, 'state', 'subagents'),
    browserDir: resolve(projectDataDir, 'state', 'browser'),
    artifactsDir: resolve(projectDataDir, 'artifacts'),
    toolOutputsDir: resolve(projectDataDir, 'artifacts', 'tool-outputs'),
    screenshotsDir: resolve(projectDataDir, 'artifacts', 'screenshots'),
    tmpDir: resolve(projectDataDir, 'tmp'),
    backupsDir: resolve(projectDataDir, 'tmp', 'backups'),
    // 独立锁目录：与 Skill 包目录隔离，避免锁文件被 Skill 扫描误识别。
    skillLocksDir: resolve(userConfigDir, '.locks', 'skills'),
  };

  return Object.freeze(paths);
}

/**
 * 尝试验证应用数据根可创建，失败时输出控制台错误且不创建目录。
 * 调用方应在确认路径有效后按需创建子目录。
 *
 * @param appDataRoot - 用户应用数据根路径
 * @returns true 如果根可写（或已存在），否则 false
 */
export function ensureAppDataRoot(appDataRoot: string): boolean {
  try {
    if (!existsSync(appDataRoot)) {
      mkdirSync(appDataRoot, { recursive: true });
    }
    accessSync(appDataRoot, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 校验 workspace 为有效绝对路径。
 *
 * @param workspace - 待校验的工作区路径
 * @throws 当 workspace 为空串、相对路径或包含非法字符时抛出错误
 */
function validateWorkspace(workspace: string): void {
  if (!workspace || workspace.trim().length === 0) {
    throw new Error('Workspace 路径不能为空');
  }
  if (!workspace.startsWith('/') && !workspace.match(/^[a-zA-Z]:[\\/]/)) {
    throw new Error(`Workspace 路径必须是绝对路径: ${workspace}`);
  }
}

/**
 * 计算 workspace key：清洗后的 basename + `-` + SHA-256 摘要前 12 位。
 *
 * Windows 路径在摘要前统一为小写盘符和正斜杠分隔符，确保等价表示生成相同 key。
 *
 * @param workspace - 规范化后的工作区绝对路径
 * @returns 稳定唯一的 workspace key
 */
function computeWorkspaceKey(workspace: string): string {
  const normalized = normalizePathForKey(workspace);
  const basename = extractBasename(workspace);
  const hash = createHash('sha256')
    .update(normalized, 'utf-8')
    .digest('hex')
    .slice(0, 12);
  return `${basename}-${hash}`;
}

/**
 * 提取路径的清洗后 basename；根目录（如 `C:\`）返回 `root`。
 *
 * @param absPath - 绝对路径
 * @returns 安全的 basename 片段
 */
function extractBasename(absPath: string): string {
  const cleaned = absPath.replace(/[/\\]$/, '');
  const base = cleaned.split(/[/\\]/).pop() || 'root';
  // 移除 Windows 盘符后的空串保护
  return base || 'root';
}

/**
 * 将绝对路径归一化为用于 key 摘要的稳定字符串。
 * Windows：统一盘符小写、反斜杠转正斜杠、去除末尾分隔符。
 *
 * @param absPath - 规范化绝对路径
 * @returns 用于摘要的标准化字符串
 */
function normalizePathForKey(absPath: string): string {
  let normalized = absPath.replace(/\\/g, '/');
  // 统一 Windows 盘符为小写
  if (normalized.length >= 2 && normalized[1] === ':') {
    normalized = normalized[0].toLowerCase() + normalized.slice(1);
  }
  // 去除末尾分隔符
  normalized = normalized.replace(/\/$/, '');
  return normalized;
}
