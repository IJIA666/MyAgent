/**
 * @file 全局有副作用执行入口清单。
 * 枚举所有本地 NativeTool、MCP、tail call、Terminal、插件和内部 helper 中有副作用的执行入口。
 * 配合 contract 测试验证 ToolCatalog 有副作用工具与 manifest 一一对应，
 * 确保新增 effectful 工具不会无声遗漏权限适配器。
 */

// ── 类型 ──

/** 执行入口类别。 */
export type EntrypointKind =
  | 'native-tool'
  | 'mcp-call'
  | 'tail-call'
  | 'terminal'
  | 'plugin'
  | 'internal-helper';

/** 执行入口的 副作用分类。 */
export type SideEffect = 'read' | 'write' | 'mixed';

/** 一条有副作用的执行入口记录。 */
export interface EffectfulEntrypoint {
  /** 入口唯一名称（工具名或辅助函数名）。 */
  readonly name: string;
  /** 入口类别。 */
  readonly kind: EntrypointKind;
  /** 声明副作用。 */
  readonly sideEffect: SideEffect;
  /** 文件系统路径。 */
  readonly sourcePath: string;
  /** 已注册 ToolAuthorizationAdapter 的名称；缺失时标记为 pending。 */
  readonly adapterName?: string;
}

// ── 本地文件系统工具 ──

const FILE_TOOLS: readonly EffectfulEntrypoint[] = [
  { name: 'readFile', kind: 'native-tool', sideEffect: 'read', sourcePath: 'src/adapters/tools/impl/filesystem/file-system.ts', adapterName: 'readFileAdapter' },
  { name: 'writeFile', kind: 'native-tool', sideEffect: 'write', sourcePath: 'src/adapters/tools/impl/filesystem/file-system.ts', adapterName: 'writeFileAdapter' },
  { name: 'editFile', kind: 'native-tool', sideEffect: 'write', sourcePath: 'src/adapters/tools/impl/filesystem/file-system.ts', adapterName: 'editFileAdapter' },
  { name: 'applyPatch', kind: 'native-tool', sideEffect: 'write', sourcePath: 'src/adapters/tools/impl/filesystem/apply-patch.ts', adapterName: 'applyPatchAdapter' },
  { name: 'createDirectory', kind: 'native-tool', sideEffect: 'write', sourcePath: 'src/adapters/tools/impl/filesystem/directory-manager.ts', adapterName: 'createDirectoryAdapter' },
  { name: 'deletePath', kind: 'native-tool', sideEffect: 'write', sourcePath: 'src/adapters/tools/impl/filesystem/directory-manager.ts', adapterName: 'deletePathAdapter' },
  { name: 'movePath', kind: 'native-tool', sideEffect: 'write', sourcePath: 'src/adapters/tools/impl/filesystem/directory-manager.ts', adapterName: 'movePathAdapter' },
  { name: 'copyPath', kind: 'native-tool', sideEffect: 'write', sourcePath: 'src/adapters/tools/impl/filesystem/directory-manager.ts', adapterName: 'copyPathAdapter' },
  { name: 'listFiles', kind: 'native-tool', sideEffect: 'read', sourcePath: 'src/adapters/tools/impl/filesystem/file-system.ts' },
  { name: 'readManyFiles', kind: 'native-tool', sideEffect: 'read', sourcePath: 'src/adapters/tools/impl/filesystem/read-many-files.ts' },
  { name: 'grepSearch', kind: 'native-tool', sideEffect: 'read', sourcePath: 'src/adapters/tools/impl/filesystem/search.ts' },
  { name: 'globSearch', kind: 'native-tool', sideEffect: 'read', sourcePath: 'src/adapters/tools/impl/filesystem/search.ts' },
];

// ── Shell/Terminal 工具 ──

const SHELL_TOOLS: readonly EffectfulEntrypoint[] = [
  { name: 'Bash', kind: 'terminal', sideEffect: 'write', sourcePath: 'src/adapters/tools/impl/system/terminal.ts', adapterName: 'shellToolAuthorizationAdapter' },
  { name: 'PowerShell', kind: 'terminal', sideEffect: 'write', sourcePath: 'src/adapters/tools/impl/system/terminal.ts', adapterName: 'shellToolAuthorizationAdapter' },
];

// ── Git 工具 ──

const GIT_TOOLS: readonly EffectfulEntrypoint[] = [
  { name: 'gitShowStatus', kind: 'native-tool', sideEffect: 'read', sourcePath: 'src/adapters/tools/impl/git/git-show-status.ts' },
  { name: 'gitShowLog', kind: 'native-tool', sideEffect: 'read', sourcePath: 'src/adapters/tools/impl/git/git-show-log.ts' },
  { name: 'gitShowDiff', kind: 'native-tool', sideEffect: 'read', sourcePath: 'src/adapters/tools/impl/git/git-show-diff.ts' },
];

// ── 交互工具 ──

const INTERACTION_TOOLS: readonly EffectfulEntrypoint[] = [
  { name: 'ask_user_question', kind: 'native-tool', sideEffect: 'read', sourcePath: 'src/adapters/tools/impl/interaction/ask-user-question.ts' },
];

// ── 技能工具 ──

const SKILL_TOOLS: readonly EffectfulEntrypoint[] = [
  { name: 'load_skill', kind: 'plugin', sideEffect: 'read', sourcePath: 'src/adapters/tools/impl/skill/skill.ts' },
];

// ── 浏览器工具 ──

const BROWSER_TOOLS: readonly EffectfulEntrypoint[] = [
  { name: 'browser_navigate', kind: 'native-tool', sideEffect: 'write', sourcePath: 'src/adapters/tools/impl/browser/browser-action.ts', adapterName: 'browserToolAuthorizationAdapter' },
  { name: 'browser_click', kind: 'native-tool', sideEffect: 'write', sourcePath: 'src/adapters/tools/impl/browser/browser-action.ts', adapterName: 'browserToolAuthorizationAdapter' },
  { name: 'browser_type', kind: 'native-tool', sideEffect: 'write', sourcePath: 'src/adapters/tools/impl/browser/browser-action.ts', adapterName: 'browserToolAuthorizationAdapter' },
  { name: 'browser_scroll', kind: 'native-tool', sideEffect: 'write', sourcePath: 'src/adapters/tools/impl/browser/browser-action.ts', adapterName: 'browserToolAuthorizationAdapter' },
  { name: 'browser_back', kind: 'native-tool', sideEffect: 'write', sourcePath: 'src/adapters/tools/impl/browser/browser-action.ts', adapterName: 'browserToolAuthorizationAdapter' },
  { name: 'browser_press', kind: 'native-tool', sideEffect: 'write', sourcePath: 'src/adapters/tools/impl/browser/browser-action.ts', adapterName: 'browserToolAuthorizationAdapter' },
  { name: 'browser_vision', kind: 'native-tool', sideEffect: 'write', sourcePath: 'src/adapters/tools/impl/browser/browser-action.ts', adapterName: 'browserToolAuthorizationAdapter' },
  { name: 'browser_ensure_login', kind: 'native-tool', sideEffect: 'write', sourcePath: 'src/adapters/tools/impl/browser/browser-action.ts', adapterName: 'browserToolAuthorizationAdapter' },
  { name: 'browser_get_text', kind: 'native-tool', sideEffect: 'read', sourcePath: 'src/adapters/tools/impl/browser/browser-action.ts', adapterName: 'browserToolAuthorizationAdapter' },
];

// ── MCP ──

const MCP_ENTRYPOINTS: readonly EffectfulEntrypoint[] = [
  { name: 'mcp__*', kind: 'mcp-call', sideEffect: 'mixed', sourcePath: 'src/adapters/tools/mcp-client.ts', adapterName: 'mcpToolAuthorizationAdapter' },
];

// ── 插件注入的 tail call ──

const TAIL_CALL_ENTRYPOINTS: readonly EffectfulEntrypoint[] = [
  {
    name: 'tailToolCallRequest',
    kind: 'tail-call',
    sideEffect: 'mixed',
    sourcePath: 'src/core/usecases/engine/tool-call-orchestrator.ts',
    adapterName: 'ToolRegistry.callTool',
  },
];

// ── 内部有副作用辅助函数 ──

const INTERNAL_HELPERS: readonly EffectfulEntrypoint[] = [
  {
    name: 'copyRecursiveSync',
    kind: 'internal-helper',
    sideEffect: 'write',
    sourcePath: 'src/adapters/tools/impl/filesystem/directory-manager-helper.ts',
    adapterName: 'delegated-directory-tool-boundary',
  },
];

// ── 聚合列表 ──

/**
 * 全部有副作用执行入口的聚合列表。
 * 工具编排器、架构测试和配置审计使用此清单验证覆盖完整度。
 */
export const EFFECTFUL_ENTRYPOINTS: readonly EffectfulEntrypoint[] = [
  ...FILE_TOOLS,
  ...SHELL_TOOLS,
  ...GIT_TOOLS,
  ...INTERACTION_TOOLS,
  ...SKILL_TOOLS,
  ...BROWSER_TOOLS,
  ...MCP_ENTRYPOINTS,
  ...TAIL_CALL_ENTRYPOINTS,
  ...INTERNAL_HELPERS,
];

/**
 * 返回所有标记为 `write` 或 `mixed` 的 effectful 入口名称集合。
 * 用于测试验证这些工具都已注册 authorizationAdapter。
 *
 * @returns entrypoint 名称集合
 */
export function getEffectfulWriteEntrypointNames(): Set<string> {
  return new Set(
    EFFECTFUL_ENTRYPOINTS
      .filter(e => e.sideEffect === 'write' || e.sideEffect === 'mixed')
      .filter(e => e.kind !== 'mcp-call') // MCP 动态注册，不在静态清单验证范围内
      .map(e => e.name),
  );
}
