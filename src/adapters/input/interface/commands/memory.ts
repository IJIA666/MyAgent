/**
 * @file `/memory` 长期记忆管理命令。
 * 提供 Auto Memory 开关、当前根、显式 topic 诊断与候选 provenance 管理；
 * 不回显 MEMORY.md、topic 或候选正文，也不把记忆内容当作权限配置。
 */

import type { ICommand, CommandContext } from './base.js';
import type {
  MemoryDiagnostic,
} from '../../../../core/usecases/brain/memory-loader.js';
import { theme } from '../views/theme.js';

/** Auto Memory 状态和候选管理命令。 */
export class MemoryCommand implements ICommand {
  name = 'memory';
  description = '查看和管理 Auto Memory';

  /**
   * 执行 `/memory` 子命令。
   *
   * @param args - status、on、off、diagnose、candidates 或 discard
   * @param context - 当前 CLI 会话上下文
   */
  public async execute(args: string[], context: CommandContext): Promise<void> {
    switch (args[0] ?? 'status') {
      case 'status':
        renderMemoryStatus(context);
        return;
      case 'on':
      case 'off':
        await updateAutoMemory(args[0] === 'on', context);
        return;
      case 'diagnose':
        renderTopicDiagnostic(context);
        return;
      case 'candidates':
        renderCandidates(context);
        return;
      case 'discard':
        discardCandidate(args[1], context);
        return;
      case 'help':
        renderMemoryHelp();
        return;
      default:
        throw new Error('未知 memory 子命令。输入 /memory help 查看用法。');
    }
  }
}

/** 输出不含记忆正文的状态摘要。 */
function renderMemoryStatus(context: CommandContext): void {
  const getStatus = context.session.getMemoryStatus;
  if (!getStatus) {
    throw new Error('当前会话不支持 Auto Memory 状态查询');
  }
  const status = getStatus.call(context.session);
  console.log();
  console.log(theme.highlight('╌ Auto Memory 状态 ╌'));
  console.log(`  开关: ${status.enabled ? theme.success('开启') : theme.dim('关闭')}`);
  console.log(`  根类型: ${status.rootKind === 'default' ? '默认项目根' : '受信自定义根'}`);
  console.log(`  当前根: ${status.memoryDir}`);
  console.log(`  索引引用: ${status.indexedTopicCount}`);
  console.log(`  启动投影: ${status.isEmpty ? '空' : '已加载'}${status.isTruncated ? '（已截断）' : ''}`);
  renderDiagnostic(status.diagnostic);
  console.log();
  console.log(theme.dim('topic 正文不会在启动时读取；使用 /memory diagnose 显式诊断。'));
}

/** 持久化开关，并在当前会话内立即刷新投影。 */
async function updateAutoMemory(
  enabled: boolean,
  context: CommandContext,
): Promise<void> {
  const update = context.session.setAutoMemoryEnabled;
  if (!update) {
    throw new Error('当前会话不支持 Auto Memory 开关更新');
  }
  await update.call(context.session, enabled);
  console.log(theme.success(`Auto Memory 已${enabled ? '开启' : '关闭'}。`));
}

/** 显式读取 topic 元数据并展示诊断，不显示正文。 */
function renderTopicDiagnostic(context: CommandContext): void {
  const diagnose = context.session.diagnoseMemoryTopics;
  if (!diagnose) {
    throw new Error('当前会话不支持 topic 诊断');
  }
  const result = diagnose.call(context.session);
  console.log();
  console.log(theme.highlight('╌ Memory topic 显式诊断 ╌'));
  console.log(`  索引引用: ${result.snapshot.topics.length}`);
  console.log(`  已读取并解析: ${result.topics.length}`);
  renderDiagnostic(result.diagnostic);
  if (result.topics.length > 0) {
    console.log();
    console.log(theme.highlight('╌ Topic 元数据 ╌'));
    for (const topic of result.topics) {
      console.log(`  ${topic.slug} [${topic.type ?? 'unknown'}] — ${topic.description}`);
    }
  }
}

/** 展示候选 provenance 和摘要，不显示尚未激活的正文。 */
function renderCandidates(context: CommandContext): void {
  const list = context.session.listMemoryCandidates;
  if (!list) {
    throw new Error('当前会话不支持记忆候选管理');
  }
  const candidates = list.call(context.session);
  console.log();
  console.log(theme.highlight('╌ 暂存记忆候选 ╌'));
  if (candidates.length === 0) {
    console.log(theme.dim('  无'));
    return;
  }
  for (const candidate of candidates) {
    console.log(
      `  ${candidate.id} [${candidate.provenance.source}/${candidate.provenance.trust}]`
      + ` ${candidate.stagedAt} — ${candidate.summary}`,
    );
  }
  console.log(theme.dim('  候选未写入 MEMORY.md，因此不会自动注入。'));
}

/** 撤销一个候选，严格按 UUID 管理，禁止路径参数。 */
function discardCandidate(
  candidateId: string | undefined,
  context: CommandContext,
): void {
  if (!candidateId) {
    throw new Error('用法: /memory discard <candidate-id>');
  }
  const discard = context.session.discardMemoryCandidate;
  if (!discard) {
    throw new Error('当前会话不支持记忆候选管理');
  }
  const removed = discard.call(context.session, candidateId);
  if (!removed) {
    throw new Error(`未找到记忆候选: ${candidateId}`);
  }
  console.log(theme.success(`已撤销记忆候选: ${candidateId}`));
}

/** 输出记忆诊断计数和具体文件名，不输出文件内容。 */
function renderDiagnostic(diagnostic: MemoryDiagnostic): void {
  if (diagnostic.truncation) {
    console.log(
      `  截断: ${diagnostic.truncation.reason}，上限 ${diagnostic.truncation.limit}`,
    );
  }
  renderDiagnosticItems('重复索引', diagnostic.duplicates);
  renderDiagnosticItems('断链', diagnostic.brokenLinks);
  renderDiagnosticItems('非法文件名', diagnostic.invalidFilenames);
  renderDiagnosticItems('未知 type', diagnostic.unknownTypes);
  renderDiagnosticItems('无效 frontmatter', diagnostic.invalidFrontmatter);
  renderDiagnosticItems('警告', diagnostic.warnings);
}

/** 输出一类非空诊断。 */
function renderDiagnosticItems(label: string, items: readonly string[]): void {
  if (items.length > 0) {
    console.log(`  ${label}: ${items.join(', ')}`);
  }
}

/** 输出 `/memory` 用法。 */
function renderMemoryHelp(): void {
  console.log();
  console.log(theme.highlight('╌ /memory 管理动作 ╌'));
  console.log('  /memory status');
  console.log('  /memory on | off');
  console.log('  /memory diagnose');
  console.log('  /memory candidates');
  console.log('  /memory discard <candidate-id>');
  console.log(theme.dim('  管理视图不显示记忆正文，候选不会自动晋升为稳定记忆。'));
}
