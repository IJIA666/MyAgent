import { resolve } from 'path';
import { existsSync, mkdirSync, appendFileSync } from 'fs';
import type { ChatMessage } from './ports/LlmPort.js';
import type { ApiUsage } from './ports/TokenEstimatorPort.js';

/**
 * 记录单次 ReAct 交互闭环的结构化信息
 */
export interface InteractionRecord {
  timestamp: string;
  iteration: number;
  /**
   * 喂给大模型的历史上下文（包含 system prompt 等）
   */
  context: ChatMessage[];
  /**
   * 大模型输出的思考推理过程（链）
   */
  reasoning?: string;
  /**
   * 大模型输出的最终自然语言内容
   */
  content?: string;
  /**
   * 触发执行的工具调用及最终结果快照
   */
  tool_calls?: Array<{
    name: string;
    arguments: string;
    result?: string;
    error?: string;
  }>;
  /**
   * 预测的 Token 详情
   */
  estimated_tokens?: {
    total: number;
    system: number;
    rules: number;
    transient: number;
    history: number;
  };
  /**
   * 实际的 API Token 消耗
   */
  actual_tokens?: ApiUsage;
}

/**
 * 大模型交互追踪仪。
 * 负责将对话流水以 JSONLines 格式无损沉淀至磁盘，充当评测（Evals）阶段的“黑匣子”。
 */
export class AgentTracer {
  private traceFile: string;

  /**
   * 实例初始化。
   *
   * @param workspaceDir - 当前授权工作区的根目录，用于拼接 .myagent 存放路径
   * @param sessionId - 本次会话的唯一标识，防止覆盖历史日志
   */
  constructor(workspaceDir: string, sessionId: string) {
    const traceDir = resolve(workspaceDir, '.myagent', 'traces');
    if (!existsSync(traceDir)) {
      mkdirSync(traceDir, { recursive: true });
    }
    // 构造当前 session 的 JSONL 日志文件路径
    this.traceFile = resolve(traceDir, `trace_${sessionId}.jsonl`);
  }

  /**
   * 将一个完整的交互轮次快照写入持久化存储。
   *
   * @param record - 结构化的快照记录对象
   */
  public logInteraction(record: InteractionRecord): void {
    try {
      // 追加写入，并带有换行符符合 JSONL 规范
      const line = JSON.stringify(record) + '\n';
      appendFileSync(this.traceFile, line, 'utf-8');
    } catch (e) {
      // 容错处理：确保任何情况下的落盘失败绝不阻断核心会话流
      console.error('\n[Tracer 故障] 无法写入交互日志:', e);
    }
  }

  /**
   * 将插件的审计记录写入单独的持久化存储。
   *
   * @param record - 插件审计记录对象
   */
  public logPluginAudit(record: Record<string, unknown>): void {
    try {
      const auditFile = this.traceFile.replace('trace_', 'plugin_audit_');
      const line = JSON.stringify(record) + '\n';
      appendFileSync(auditFile, line, 'utf-8');
    } catch (e) {
      console.error('\n[Tracer 故障] 无法写入插件审计日志:', e);
    }
  }
}
