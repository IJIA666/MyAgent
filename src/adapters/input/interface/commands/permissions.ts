/**
 * @file `/permissions` 命令实现。
 * 显示当前模式、规则、额外目录和状态版本，并提供受约束的更新动作。
 */

import type { ICommand, CommandContext } from './base.js';
import { theme } from '../views/theme.js';
import { getUserPermissionModeLabel } from '../../../../core/domain/permissions/permission-types.js';
import type {
  PermissionBehavior,
  PermissionMode,
  PermissionRule,
  PermissionUpdateTarget,
} from '../../../../core/domain/permissions/permission-types.js';

export class PermissionsCommand implements ICommand {
  name = 'permissions';
  description = '查看当前权限状态和规则';

  async execute(args: string[], context: CommandContext): Promise<void> {
    if (args.length > 0) {
      await executePermissionUpdate(args, context);
      return;
    }

    console.log();
    console.log(theme.highlight('╌ 权限状态 ╌'));
    const mode = context.session.getPermissionMode();
    console.log(`  模式: ${theme.highlight(getUserPermissionModeLabel(mode))}`);
    console.log(`  内部标识: ${mode}`);
    const snapshot = context.session.getPermissionSnapshot?.();
    if (snapshot) {
      console.log(`  状态版本: ${snapshot.stateVersion}`);
      renderRules(snapshot.rules);
      renderDirectories(snapshot.additionalDirectories);
    } else {
      console.log(theme.warning('  当前会话端口未提供规则与目录快照。'));
    }
    console.log();
    console.log(theme.dim('提示: /permissions help 查看管理动作；/workmode 只切换当前会话模式。'));
  }
}

/** 输出按来源标注的有效规则。 */
function renderRules(rules: readonly PermissionRule[]): void {
  console.log();
  console.log(theme.highlight('╌ 有效规则 ╌'));
  if (rules.length === 0) {
    console.log(theme.dim('  无'));
    return;
  }
  for (const rule of rules) {
    const content = rule.ruleValue.ruleContent
      ? ` (${redactRuleContent(rule.ruleValue.ruleContent)})`
      : '';
    console.log(`  [${rule.ruleBehavior}] ${rule.ruleValue.toolName}${content} ← ${rule.source}`);
  }
}

/** 输出当前额外目录。 */
function renderDirectories(directories: readonly string[]): void {
  console.log();
  console.log(theme.highlight('╌ 额外目录 ╌'));
  if (directories.length === 0) {
    console.log(theme.dim('  无'));
    return;
  }
  directories.forEach(directory => console.log(`  ${directory}`));
}

/** 执行 `/permissions` 的受约束更新子命令。 */
async function executePermissionUpdate(
  args: string[],
  context: CommandContext,
): Promise<void> {
  if (args[0] === 'help') {
    renderPermissionHelp();
    return;
  }
  const applyUpdates = context.session.applyPermissionUpdates;
  if (!applyUpdates) {
    throw new Error('当前会话不支持权限状态更新');
  }

  switch (args[0]) {
    case 'remove-dir': {
      const directory = args.slice(1).join(' ').trim();
      if (!directory) {
        throw new Error('用法: /permissions remove-dir <绝对目录>');
      }
      await applyUpdates.call(context.session, [{
        type: 'removeDirectories',
        target: 'session',
        directories: [directory],
      }]);
      console.log(theme.success(`已移除 session 额外目录: ${directory}`));
      return;
    }
    case 'default': {
      const mode = parseCommonMode(args[1]);
      const target = parsePersistentTarget(args[2] ?? 'user');
      await applyUpdates.call(context.session, [{
        type: 'setMode',
        target,
        mode,
      }]);
      console.log(theme.success(`已将 ${target} 的未来默认模式设置为 ${getUserPermissionModeLabel(mode)}`));
      return;
    }
    case 'add-rule':
    case 'remove-rule': {
      const target = parseEditableTarget(args[1]);
      const behavior = parseBehavior(args[2]);
      const toolName = args[3]?.trim();
      if (!toolName) {
        throw new Error(`用法: /permissions ${args[0]} <session|user|project|projectLocal> <allow|ask|deny> <tool> [限定内容]`);
      }
      const ruleContent = args.slice(4).join(' ').trim() || undefined;
      await applyUpdates.call(context.session, [{
        type: args[0] === 'add-rule' ? 'addRules' : 'removeRules',
        target,
        rules: [{
          source: 'session',
          ruleBehavior: behavior,
          ruleValue: { toolName, ruleContent },
        }],
      }]);
      console.log(theme.success(`已${args[0] === 'add-rule' ? '添加' : '移除'} ${target} 权限规则。`));
      return;
    }
    case 'clear-rules': {
      const target = parseEditableTarget(args[1]);
      await applyUpdates.call(context.session, [{
        type: 'replaceRules',
        target,
        rules: [],
      }]);
      console.log(theme.success(`已清空 ${target} 的可编辑规则。`));
      return;
    }
    default:
      throw new Error('未知权限子命令。输入 /permissions help 查看用法。');
  }
}

/** 输出权限管理命令用法。 */
function renderPermissionHelp(): void {
  console.log();
  console.log(theme.highlight('╌ /permissions 管理动作 ╌'));
  console.log('  /permissions remove-dir <绝对目录>');
  console.log('  /permissions default <manual|accept-edits|plan> [user|project|projectLocal]');
  console.log('  /permissions add-rule <target> <allow|ask|deny> <tool> [限定内容]');
  console.log('  /permissions remove-rule <target> <allow|ask|deny> <tool> [限定内容]');
  console.log('  /permissions clear-rules <target>');
  console.log(theme.dim('  managed/host policy 只读，不能通过此入口修改。'));
}

/** 解析普通用户可见模式。 */
function parseCommonMode(value: string | undefined): PermissionMode {
  switch (value) {
    case 'manual': return 'default';
    case 'accept-edits': return 'acceptEdits';
    case 'plan': return 'plan';
    default: throw new Error('模式必须是 manual、accept-edits 或 plan');
  }
}

/** 解析允许持久化未来默认的目标。 */
function parsePersistentTarget(value: string): Exclude<PermissionUpdateTarget, 'session'> {
  if (value === 'user' || value === 'project' || value === 'projectLocal') {
    return value;
  }
  if (value === 'managed' || value === 'host') {
    throw new Error('managed/host policy 为只读来源');
  }
  throw new Error('持久目标必须是 user、project 或 projectLocal');
}

/** 解析规则可编辑目标。 */
function parseEditableTarget(value: string | undefined): PermissionUpdateTarget {
  if (value === 'session' || value === 'user' || value === 'project' || value === 'projectLocal') {
    return value;
  }
  if (value === 'managed' || value === 'host') {
    throw new Error('managed/host policy 为只读来源');
  }
  throw new Error('规则目标必须是 session、user、project 或 projectLocal');
}

/** 解析权限规则行为。 */
function parseBehavior(value: string | undefined): PermissionBehavior {
  if (value === 'allow' || value === 'ask' || value === 'deny') {
    return value;
  }
  throw new Error('规则行为必须是 allow、ask 或 deny');
}

/** 去除换行并限制规则限定内容的显示长度。 */
function redactRuleContent(content: string): string {
  const singleLine = content.replace(/\s+/g, ' ');
  return singleLine.length > 120 ? `${singleLine.slice(0, 117)}...` : singleLine;
}
