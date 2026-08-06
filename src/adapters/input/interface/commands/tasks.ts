import type { CommandContext, ICommand } from './base.js';
import { theme } from '../views/theme.js';
import type {
  CliAgentTaskCancelResult,
  CliAgentTaskDetail,
} from '../../../../ports/driving/CliSessionUseCase.js';

/** `/tasks` 命令：查询和取消当前父会话的低敏子代理任务。 */
export class TasksCommand implements ICommand {
  /** 命令名称。 */
  public readonly name = 'tasks';
  /** 命令帮助描述。 */
  public readonly description = '查看、展示或停止子代理任务';

  /** 根据子命令驱动 list/show/stop 控制面。 */
  public async execute(args: string[], context: CommandContext): Promise<void> {
    const normalized = args.filter(Boolean);
    const action = normalized[0]?.toLowerCase() ?? 'list';
    if (action === 'show') {
      await this.show(normalized[1], context);
      return;
    }
    if (action === 'stop') {
      await this.stop(normalized[1], context);
      return;
    }
    await this.list(context);
  }

  /** 展示按创建时间倒序排列的任务摘要。 */
  private async list(context: CommandContext): Promise<void> {
    const tasks = [...await context.session.listAgentTasks()].reverse();
    if (tasks.length === 0) {
      console.log(theme.info('[tasks] 当前会话没有子代理任务。'));
      return;
    }
    for (const task of tasks) {
      console.log(`[${task.status}] ${task.agentId}  ${task.description}  ${task.createdAt}`);
    }
  }

  /** 展示单条任务的扫描结果、错误和 usage。 */
  private async show(agentId: string | undefined, context: CommandContext): Promise<void> {
    if (!agentId) {
      console.log(theme.error('[tasks show] 缺少任务 ID。'));
      return;
    }
    const detail = await context.session.getAgentTask(agentId);
    if (!isTaskDetail(detail)) {
      console.log(theme.error(`[tasks show] 任务不存在：${agentId}`));
      return;
    }
    renderTaskDetail(detail);
  }

  /** 停止一条任务或全部非终态任务。 */
  private async stop(agentId: string | undefined, context: CommandContext): Promise<void> {
    if (!agentId || (agentId !== 'all' && agentId.trim().length === 0)) {
      console.log(theme.error('[tasks stop] 用法：/tasks stop <id|all>。'));
      return;
    }
    const result = await context.session.cancelAgentTask(agentId);
    if (isCancelResultArray(result)) {
      for (const item of result) {
        renderCancelResult(item);
      }
      return;
    }
    renderCancelResult(result);
  }
}

/** 识别 driving port 返回的任务详情成功分支。 */
function isTaskDetail(
  value: CliAgentTaskDetail | { readonly status: 'not_found' },
): value is CliAgentTaskDetail {
  return 'task' in value;
}

/** 识别 all 取消返回的只读结果数组。 */
function isCancelResultArray(
  value: CliAgentTaskCancelResult | readonly CliAgentTaskCancelResult[],
): value is readonly CliAgentTaskCancelResult[] {
  return Array.isArray(value);
}

/** 渲染低敏任务详情。 */
function renderTaskDetail(detail: CliAgentTaskDetail): void {
  const task = detail.task;
  console.log(`[${task.status}] ${task.agentId}  ${task.description}`);
  if (detail.result) {
    console.log(detail.result);
  }
  if (detail.error) {
    console.log(theme.error(`[错误] ${detail.error}`));
  }
  if (task.usage) {
    console.log(`usage: totalTokens=${task.usage.totalTokens ?? '-'} toolUses=${task.usage.toolUses} durationMs=${task.usage.durationMs}`);
  }
}

/** 渲染幂等取消结果。 */
function renderCancelResult(result: CliAgentTaskCancelResult): void {
  if (result.status === 'not_found') {
    console.log(theme.error('[tasks stop] 任务不存在。'));
    return;
  }
  if (result.status === 'error') {
    console.log(theme.error(`[tasks stop] ${result.message}`));
    return;
  }
  console.log(theme.info(`[tasks stop] ${result.agentId}：${result.status}`));
}
