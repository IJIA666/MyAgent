/**
 * @file 凭据作用域与最小子进程环境构造。
 * 明确 provider、browser、MCP、插件、Terminal、子 Agent 的 credential audience；
 * 宿主环境只复制启动所需的基础变量，受众凭据必须由受信组合根显式注入。
 */

/** 凭据受众类型。 */
export type CredentialAudience =
  | 'model-provider'
  | 'browser'
  | 'mcp-server'
  | 'plugin'
  | 'terminal'
  | 'sub-agent';

/** 单一凭据条目。 */
export interface CredentialEntry {
  /** 环境变量名称。 */
  readonly name: string;
  /** 凭据受众。 */
  readonly audience: CredentialAudience;
  /** 是否是启动所必需的凭据。 */
  readonly required: boolean;
}

/** 凭据作用域配置。 */
export interface CredentialProfile {
  /** 受众。 */
  readonly audience: CredentialAudience;
  /** grant 和审计绑定的 profile 版本。 */
  readonly version: string;
  /** 该受众可由组合根显式选择的凭据名称。 */
  readonly allowedEnvVars: readonly string[];
  /** 凭据条目列表。 */
  readonly entries: readonly CredentialEntry[];
  /**
   * 是否从宿主复制该 profile 的 allowlist。
   * 即使为 true 也绝不代表复制完整 `process.env`。
   */
  readonly inheritHostEnv: boolean;
}

/**
 * 所有子进程可继承的非凭据启动环境。
 * 只包含命令查找、用户目录、区域、临时目录和平台运行库所需字段。
 */
export const BASE_PROCESS_ENV_VARS: readonly string[] = Object.freeze([
  'PATH',
  'HOME',
  'USER',
  'USERNAME',
  'USERPROFILE',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'TMPDIR',
  'SystemRoot',
  'SystemDrive',
  'HOMEDRIVE',
  'HOMEPATH',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'CommonProgramFiles',
  'ComSpec',
  'TERM',
  'COLORTERM',
  'PSModulePath',
  'DISPLAY',
  'WAYLAND_DISPLAY',
]);

/** Provider 可由组合根精确选择的凭据。 */
const MODEL_PROVIDER_CREDENTIALS: readonly string[] = Object.freeze([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'AZURE_OPENAI_KEY',
  'OPENAI_BASE_URL',
  'ANTHROPIC_BASE_URL',
]);

/** Browser 只允许显式的连接配置，不自动继承站点或 provider 凭据。 */
const BROWSER_CREDENTIALS: readonly string[] = Object.freeze([
  'BROWSER_CDP_URL',
  'BROWSER_USER_DATA_DIR',
  'BROWSER_HEADLESS',
]);

/** Terminal 自动继承的宿主字段仍受基础变量白名单限制。 */
const TERMINAL_HOST_ENV: readonly string[] = BASE_PROCESS_ENV_VARS;

/** 创建并冻结一个 profile。 */
function createProfile(
  audience: CredentialAudience,
  allowedEnvVars: readonly string[],
  inheritHostEnv: boolean,
): CredentialProfile {
  const entries = allowedEnvVars.map(name => Object.freeze({
    name,
    audience,
    required: false,
  }));
  return Object.freeze({
    audience,
    version: '1.0.0',
    allowedEnvVars: Object.freeze([...allowedEnvVars]),
    entries: Object.freeze(entries),
    inheritHostEnv,
  });
}

/**
 * 为指定受众创建最小凭据 profile。
 *
 * @param audience - 凭据受众
 * @returns 冻结的最小 CredentialProfile
 */
export function createCredentialProfile(audience: CredentialAudience): CredentialProfile {
  switch (audience) {
    case 'model-provider':
      return createProfile(audience, MODEL_PROVIDER_CREDENTIALS, false);
    case 'browser':
      return createProfile(audience, BROWSER_CREDENTIALS, false);
    case 'mcp-server':
      return createProfile(audience, [], false);
    case 'plugin':
      return createProfile(audience, [], false);
    case 'terminal':
      return createProfile(audience, TERMINAL_HOST_ENV, true);
    case 'sub-agent':
      return createProfile(audience, [], false);
  }
}

/**
 * 按凭据 profile 构造最小环境。
 * 基础系统变量始终按白名单复制；只有 `inheritHostEnv` 为 true 时才从宿主复制
 * profile allowlist。`explicitEnv` 代表受信配置已经精确选择的凭据，优先级最高。
 *
 * @param profile - 目标受众 profile
 * @param hostEnv - 宿主环境快照
 * @param explicitEnv - 受信配置明确注入的环境
 * @returns 不含 undefined 的冻结环境字典
 */
export function createCredentialEnvironment(
  profile: CredentialProfile,
  hostEnv: Readonly<Record<string, string | undefined>>,
  explicitEnv: Readonly<Record<string, string | undefined>> = {},
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  copySelectedEnvironment(environment, hostEnv, BASE_PROCESS_ENV_VARS);
  for (const [key, value] of Object.entries(hostEnv)) {
    if (key.startsWith('XDG_') && value !== undefined) {
      environment[key] = value;
    }
  }
  if (profile.inheritHostEnv) {
    copySelectedEnvironment(environment, hostEnv, profile.allowedEnvVars);
  }
  for (const [key, value] of Object.entries(explicitEnv)) {
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  return Object.freeze(environment);
}

/** 将选定宿主字段复制到目标环境。 */
function copySelectedEnvironment(
  target: Record<string, string>,
  source: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): void {
  for (const name of names) {
    const value = source[name];
    if (value !== undefined) {
      target[name] = value;
    }
  }
}
