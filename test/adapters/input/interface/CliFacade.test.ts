/**
 * @fileoverview CliFacade 的单元测试，用于验证 REPL 控制、门面路由及 UI 流式事件渲染。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import readline from 'readline';
import { EventEmitter } from 'events';
import { CliFacade } from '../../../../src/adapters/input/interface/facade.js';
import { dispatchCommand, showInteractiveMenu } from '../../../../src/adapters/input/interface/command.js';
import { BrowserSession } from '../../../../src/adapters/tools/impl/browser/browser-action.js';
import { waitUserIntervention } from '../../../../src/adapters/input/interface/cli.js';

vi.mock('../../../../src/adapters/input/interface/command.js', () => {
  return {
    dispatchCommand: vi.fn(),
    showInteractiveMenu: vi.fn(),
  };
});

vi.mock('../../../../src/adapters/input/interface/cli.js', () => {
  return {
    waitUserIntervention: vi.fn(),
  };
});

class MockChatUseCase extends EventEmitter {
  getIsGenerating = vi.fn().mockReturnValue(false);
  getModelName = vi.fn().mockReturnValue('mock-llama-3');
  getWorkMode = vi.fn().mockReturnValue('Auto');
  setWorkMode = vi.fn();
  abort = vi.fn();
  rollback = vi.fn();
  compact = vi.fn().mockResolvedValue(true);
  getSessionId = vi.fn().mockReturnValue('session-1');
  getHistory = vi.fn().mockReturnValue([]);
  getLastEstimatedUsage = vi.fn().mockReturnValue(null);
  getLastApiUsage = vi.fn().mockReturnValue(null);
  getSystemPromptHash = vi.fn().mockReturnValue('dummypromptmd5hash');
  close = vi.fn().mockResolvedValue(undefined);
  loadState = vi.fn().mockResolvedValue(true);
  reloadRules = vi.fn();
  switchModel = vi.fn();
  handleUserInput = vi.fn();
  resumePendingInteraction = vi.fn().mockResolvedValue(undefined);
  getPendingInteraction = vi.fn().mockReturnValue(null);
  getAvailableSkills = vi.fn().mockReturnValue([]);
  getSkillContent = vi.fn().mockReturnValue(null);
  setInteractionPort = vi.fn();
  registerApprovalHandler = vi.fn();
  toolRegistryInstance = {
    mcpManager: undefined,
    getTools: vi.fn(),
    callTool: vi.fn(),
    getTool: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined)
  };
  approvalService = {
    wait: vi.fn(),
    resolve: vi.fn(),
  };
}

describe('CliFacade', () => {
  let mockSession: MockChatUseCase;
  let facade: CliFacade;
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn> & { outputBuffer: string[] };
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let mockRlInterface: Record<string, unknown>;

  beforeEach(() => {
    mockSession = new MockChatUseCase() as unknown as MockChatUseCase;

    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      return undefined as never;
    });

    mockRlInterface = {
      on: vi.fn(),
      close: vi.fn(),
      write: vi.fn(),
      prompt: vi.fn(),
      setPrompt: vi.fn(),
      question: vi.fn(),
    };
    vi.spyOn(readline, 'createInterface').mockReturnValue(mockRlInterface as unknown as readline.Interface);

    const outputBuffer: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((str: string | Uint8Array) => {
      outputBuffer.push(str.toString());
      return true;
    }) as unknown as typeof process.stdout.write);

    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      outputBuffer.push(args.join(' ') + '\n');
    });

    stdoutWriteSpy = Object.assign(spy, { outputBuffer, consoleLogSpy });

    facade = new CliFacade(mockSession);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function cleanAnsi(str: string): string {
    const esc1 = String.fromCharCode(0x1b);
    const esc2 = String.fromCharCode(0x9b);
    const pattern = `[${esc1}${esc2}][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]`;
    const ansiRegex = new RegExp(pattern, 'g');
    return str.replace(ansiRegex, '');
  }

  function getCleanedOutput(): string {
    return cleanAnsi(stdoutWriteSpy.outputBuffer.join(''));
  }

  describe('REPL 命令解析分发与退出', () => {
    it('当输入 exit 或 quit 时，应当正常优雅终止会话并调用 process.exit(0)', async () => {
      const onLineSubmit = facade['listener']['onLineSubmit'];
      
      await onLineSubmit('exit');

      expect(mockSession.close).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(getCleanedOutput()).toContain('进程正在终止，结束会话');
    });

    it('当输入常规文本时，应当将其提交至会话管理器 handleUserInput', async () => {
      const onLineSubmit = facade['listener']['onLineSubmit'];
      await onLineSubmit('hello world');
      expect(mockSession.handleUserInput).toHaveBeenCalledWith('hello world');
    });

    it('当输入空行时，应该直接刷新 prompt 提示不作任何提交', async () => {
      const promptSpy = vi.spyOn(facade['listener'], 'prompt').mockImplementation(() => {});
      const onLineSubmit = facade['listener']['onLineSubmit'];
      
      await onLineSubmit('   ');
      expect(mockSession.handleUserInput).not.toHaveBeenCalled();
      expect(promptSpy).toHaveBeenCalled();
    });

    it('当输入以斜杠开头的自定义命令且不触发后续 LLM 交互时，应当以 stdin 独占事务执行并恢复 active 监听', async () => {
      vi.mocked(dispatchCommand).mockResolvedValue(undefined);
      const onLineSubmit = facade['listener']['onLineSubmit'];

      const closeSpy = vi.spyOn(facade['listener'], 'close');
      const startSpy = vi.spyOn(facade['listener'], 'start');

      await onLineSubmit('/help');

      expect(closeSpy).toHaveBeenCalled();
      expect(dispatchCommand).toHaveBeenCalledWith('/help', { session: mockSession });
      expect(startSpy).toHaveBeenCalledWith(false); // 纯命令，active 重建
      expect(mockSession.handleUserInput).not.toHaveBeenCalled();
    });

    it('当输入命令返回了需要与 LLM 交互的追加会话与沙盒技能时，应当以 paused 重建监听器后提交交互', async () => {
      vi.mocked(dispatchCommand).mockResolvedValue({
        transientSkillContent: 'sandbox code',
        userMessage: 'user command action'
      });
      const onLineSubmit = facade['listener']['onLineSubmit'];

      const closeSpy = vi.spyOn(facade['listener'], 'close');
      const startSpy = vi.spyOn(facade['listener'], 'start');

      await onLineSubmit('/run-skill');

      expect(closeSpy).toHaveBeenCalled();
      expect(startSpy).toHaveBeenCalledWith(true); // paused，由 complete 恢复
      expect(mockSession.handleUserInput).toHaveBeenCalledWith('user command action', 'sandbox code');
    });

    it('当输入单个斜杠启动交互菜单并退出时，不作任何提交且恢复 active 监听', async () => {
      vi.mocked(showInteractiveMenu).mockResolvedValue(null);
      const onLineSubmit = facade['listener']['onLineSubmit'];

      const closeSpy = vi.spyOn(facade['listener'], 'close');
      const startSpy = vi.spyOn(facade['listener'], 'start');

      await onLineSubmit('/');

      expect(closeSpy).toHaveBeenCalled();
      expect(showInteractiveMenu).toHaveBeenCalled();
      expect(startSpy).toHaveBeenCalledWith(false); // active 重建
    });

    it('当输入单个斜杠启动交互菜单并选择了有效指令时，应当重定向执行该指令', async () => {
      vi.mocked(showInteractiveMenu).mockResolvedValue('/help');
      vi.mocked(dispatchCommand).mockResolvedValue(undefined);
      const onLineSubmit = facade['listener']['onLineSubmit'];

      await onLineSubmit('/');

      expect(showInteractiveMenu).toHaveBeenCalled();
      expect(dispatchCommand).toHaveBeenCalledWith('/help', { session: mockSession });
    });

    it('当交互菜单抛出异常时，应当安全恢复 active 监听（异常安全恢复）', async () => {
      vi.mocked(showInteractiveMenu).mockRejectedValue(new Error('Menu crash'));
      const onLineSubmit = facade['listener']['onLineSubmit'];
      const startSpy = vi.spyOn(facade['listener'], 'start');

      // 异常被 facade 的 .catch() 吞掉，不传播到调用方
      onLineSubmit('/');
      await new Promise(resolve => setImmediate(resolve));

      // finally 块已保证 active 重建
      expect(startSpy).toHaveBeenCalledWith(false);
    });

    it('当 dispatchCommand 抛出异常时，应当安全恢复 active 监听（异常安全恢复）', async () => {
      vi.mocked(dispatchCommand).mockRejectedValue(new Error('Command crash'));
      const onLineSubmit = facade['listener']['onLineSubmit'];
      const startSpy = vi.spyOn(facade['listener'], 'start');

      onLineSubmit('/help');
      await new Promise(resolve => setImmediate(resolve));

      // finally 块已保证 active 重建
      expect(startSpy).toHaveBeenCalledWith(false);
    });

    it('当 LLM 分支中 handleUserInput 同步抛错时，不应卡死在 paused 状态', async () => {
      vi.mocked(dispatchCommand).mockResolvedValue({
        transientSkillContent: 'sandbox code',
        userMessage: 'user command action'
      });
      mockSession.handleUserInput = vi.fn(() => {
        throw new Error('Session is busy');
      });
      const onLineSubmit = facade['listener']['onLineSubmit'];
      const resumeSpy = vi.spyOn(facade['listener'], 'resume');

      await onLineSubmit('/run-skill');

      // 先以 paused 重建，同步抛错后立即 resume
      expect(resumeSpy).toHaveBeenCalled();
    });

    it('应该能够启动 REPL 主循环 start()', () => {
      const startSpy = vi.spyOn(facade['listener'], 'start').mockImplementation(() => {});
      facade.start();
      expect(startSpy).toHaveBeenCalled();
    });

    it('应该能够执行 redraw() 清屏重绘历史', () => {
      facade.redraw();
      expect(mockSession.getHistory).toHaveBeenCalled();
    });
  });

  describe('handleAgentEvent 智能体事件流式渲染', () => {
    it('should correctly render "thinking" events', () => {
      mockSession.emit('agent_event', {
        type: 'thinking',
        content: 'Analyzing codebase...'
      });

      const output = getCleanedOutput();
      expect(output).toContain('[思考过程]');
      expect(output).toContain('Analyzing codebase...');
    });

    it('should correctly render "content" events', () => {
      mockSession.emit('agent_event', { type: 'thinking', content: 'Thinking...' });
      
      mockSession.emit('agent_event', {
        type: 'content',
        content: 'This is the generated message.'
      });

      const output = getCleanedOutput();
      expect(output).toContain('This is the generated message.');
    });

    it('should correctly render "tool_call_start" and "tool_call_result" events', () => {
      mockSession.emit('agent_event', {
        type: 'tool_call_start',
        functionName: 'readFile',
        functionArgs: { targetPath: 'index.ts' }
      });

      mockSession.emit('agent_event', {
        type: 'tool_call_result',
        functionName: 'readFile',
        result: 'file content text'
      });

      const output = getCleanedOutput();
      expect(output).toContain('[⚡ 正在调用工具 "readFile"]');
      expect(output).toContain('index.ts');
      expect(output).toContain('执行完毕，返回了 17 字节的数据');
    });

    it('should correctly render "error" events', () => {
      mockSession.emit('agent_event', {
        type: 'error',
        message: 'LLM connection timeout'
      });

      const output = getCleanedOutput();
      expect(output).toContain('[异常] LLM connection timeout');
    });

    it('should correctly render "complete" events and render token panels', () => {
      mockSession.emit('agent_event', {
        type: 'complete'
      });

      const output = getCleanedOutput();
      expect(output).toContain('完毕。');
      expect(mockSession.getLastEstimatedUsage).toHaveBeenCalled();
      expect(mockSession.getLastApiUsage).toHaveBeenCalled();
      expect(mockSession.getSystemPromptHash).toHaveBeenCalled();
    });

    it('should correctly render "suspend" events and do nothing', () => {
      mockSession.emit('agent_event', {
        type: 'suspend',
        id: 'suspend-1',
        toolCall: { name: 'test', arguments: {} },
        allowedPrefix: null
      });

      const output = getCleanedOutput();
      expect(output).toBe('');
    });

    it('quality_check_status 所有 phase 均不应恢复输入，complete 只恢复一次（3.12）', () => {
      const resumeSpy = vi.spyOn(facade['listener'], 'resume');

      // started/passed/failed/cancelled 均不应恢复输入
      mockSession.emit('agent_event', { type: 'quality_check_status', phase: 'started', summary: '验证中', durationMs: 0 });
      expect(resumeSpy).not.toHaveBeenCalled();

      mockSession.emit('agent_event', { type: 'quality_check_status', phase: 'passed', summary: '通过', durationMs: 100 });
      expect(resumeSpy).not.toHaveBeenCalled();

      mockSession.emit('agent_event', { type: 'quality_check_status', phase: 'failed', summary: '失败', durationMs: 200 });
      expect(resumeSpy).not.toHaveBeenCalled();

      mockSession.emit('agent_event', { type: 'quality_check_status', phase: 'cancelled', summary: '取消', durationMs: 50 });
      expect(resumeSpy).not.toHaveBeenCalled();

      // 只有 complete 恢复输入
      mockSession.emit('agent_event', { type: 'complete' });
      expect(resumeSpy).toHaveBeenCalledTimes(1);

      const output = getCleanedOutput();
      expect(output).toContain('[验证中]');
      expect(output).toContain('[验证通过]');
      expect(output).toContain('[验证失败]');
      expect(output).toContain('[验证已取消]');
      expect(output).toContain('完毕。');
    });

    it('收到 interaction_request 时，应当拉起提问并在回答后恢复挂起交互', async () => {
      // 拦截 InteractionHandler.askUser，避免触发真实的 @clack/prompts 交互
      const askUserSpy = vi.spyOn(facade['interactionHandler'], 'askUser')
        .mockResolvedValue({ q1: '方案A' });

      mockSession.emit('agent_event', {
        type: 'interaction_request',
        interaction: {
          id: 'interaction_tool-1',
          toolName: 'ask_user_question',
          toolCallId: 'tool-1',
          createdAt: Date.now(),
          state: 'pending',
          payload: {
            questions: [{
              id: 'q1',
              header: '方案',
              question: '请选择方案',
              mode: 'single-select',
              options: [{ label: '方案A', description: '保守方案' }, { label: '方案B', description: '激进方案' }]
            }]
          }
        }
      });

      await new Promise(resolve => setImmediate(resolve));

      expect(mockSession.resumePendingInteraction).toHaveBeenCalledWith('interaction_tool-1', { q1: '方案A' });
      askUserSpy.mockRestore();
    });

    it('同一个 interactionId 收到多次 interaction_request 时，只拉起一次 UI', async () => {
      // 使用未 resolve 的 deferred promise 模拟慢速交互，确保第二次到达时第一次尚未完成
      let resolveDeferred: (value: { q1: string }) => void;
      const deferredPromise = new Promise<{ q1: string }>((resolve) => {
        resolveDeferred = resolve;
      });
      const askUserSpy = vi.spyOn(facade['interactionHandler'], 'askUser')
        .mockReturnValue(deferredPromise);

      const interaction = {
        id: 'interaction_tool-dedup',
        toolName: 'ask_user_question',
        toolCallId: 'tool-dedup',
        createdAt: Date.now(),
        state: 'pending',
        payload: {
          questions: [{
            id: 'q1',
            header: '方案',
            question: '请选择方案',
            mode: 'single-select',
            options: [{ label: '方案A', description: '保守' }, { label: '方案B', description: '激进' }]
          }]
        }
      };

      // 第一次触发
      mockSession.emit('agent_event', { type: 'interaction_request', interaction });
      await new Promise(resolve => setImmediate(resolve));
      expect(askUserSpy).toHaveBeenCalledTimes(1);

      // 第二次重复触发（此时第一次尚未完成，应被幂等丢弃）
      mockSession.emit('agent_event', { type: 'interaction_request', interaction });
      await new Promise(resolve => setImmediate(resolve));
      expect(askUserSpy).toHaveBeenCalledTimes(1);

      // 释放 deferred，让第一次完成
      resolveDeferred!({ q1: '方案A' });
      await new Promise(resolve => setImmediate(resolve));

      askUserSpy.mockRestore();
    });
  });

  describe('approvalService.registerApprovalHandler 安全审批交互', () => {
    let handler: (
      id: string,
      toolCall: { name: string; arguments: Record<string, unknown> },
      allowedPrefix?: string,
      message?: string
    ) => Promise<void>;

    beforeEach(() => {
      handler = vi.mocked(mockSession.registerApprovalHandler).mock.calls[0][0] as unknown as typeof handler;
    });

    it('当有 allowedPrefix 且用户输入 1 时，应当批准 once 并重新激活键盘监听', async () => {
      const closeSpy = vi.spyOn(facade['listener'], 'close');
      const startSpy = vi.spyOn(facade['listener'], 'start');

      // 模拟 stdin.resume，避免测试环境下的副作用
      const resumeStdinSpy = vi.spyOn(process.stdin, 'resume').mockImplementation(() => process.stdin);

      mockRlInterface.question = vi.fn().mockImplementation((_query: string, callback: (ans: string) => void) => {
        callback('1');
      });

      await handler('req-1', { name: 'run_cmd', arguments: { command: 'dir' } }, 'dir', '测试警告');

      expect(closeSpy).toHaveBeenCalled();
      expect(resumeStdinSpy).toHaveBeenCalled();
      expect(mockSession.approvalService.resolve).toHaveBeenCalledWith('req-1', { action: 'call' });
      expect(startSpy).toHaveBeenCalledWith(true);
      
      const output = getCleanedOutput();
      expect(output).toContain('[安全提示] 测试警告');
      expect(output).toContain('dir');
    });

    it('当有 allowedPrefix 且用户输入 2 时，应当批准 persistent', async () => {
      mockRlInterface.question = vi.fn().mockImplementation((_query: string, callback: (ans: string) => void) => {
        callback('2');
      });

      await handler('req-2', { name: 'run_cmd', arguments: { command: 'dir' } }, 'dir');

      expect(mockSession.approvalService.resolve).toHaveBeenCalledWith('req-2', { action: 'persistent' });
      const output = getCleanedOutput();
      expect(output).toContain('Agent 企图执行以下终端命令');
    });

    it('当有 allowedPrefix 且用户输入 3 时，应当拒绝 deny', async () => {
      mockRlInterface.question = vi.fn().mockImplementation((_query: string, callback: (ans: string) => void) => {
        callback('3');
      });

      await handler('req-3', { name: 'run_cmd', arguments: { command: 'dir' } }, 'dir');

      expect(mockSession.approvalService.resolve).toHaveBeenCalledWith('req-3', { action: 'deny' });
    });

    it('当有 allowedPrefix 且用户输入无效值时，应当提示无效并递归提问，直到输入有效值为止', async () => {
      let callCount = 0;
      mockRlInterface.question = vi.fn().mockImplementation((_query: string, callback: (ans: string) => void) => {
        callCount++;
        if (callCount === 1) {
          callback('invalid');
        } else {
          callback('1');
        }
      });

      await handler('req-4', { name: 'run_cmd', arguments: { command: 'dir' } }, 'dir');

      expect(mockSession.approvalService.resolve).toHaveBeenCalledWith('req-4', { action: 'call' });
      expect(callCount).toBe(2);
      expect(getCleanedOutput()).toContain('无效选择，请重新输入');
    });

    it('当无 allowedPrefix 且用户输入 1 时，应当批准 once', async () => {
      mockRlInterface.question = vi.fn().mockImplementation((_query: string, callback: (ans: string) => void) => {
        callback('1');
      });

      await handler('req-5', { name: 'run_cmd', arguments: {} });

      expect(mockSession.approvalService.resolve).toHaveBeenCalledWith('req-5', { action: 'call' });
    });

    it('当无 allowedPrefix 且用户输入 2 时，应当拒绝 deny', async () => {
      mockRlInterface.question = vi.fn().mockImplementation((_query: string, callback: (ans: string) => void) => {
        callback('2');
      });

      await handler('req-6', { name: 'run_cmd', arguments: {} });

      expect(mockSession.approvalService.resolve).toHaveBeenCalledWith('req-6', { action: 'deny' });
    });

    it('当无 allowedPrefix 且用户输入无效值时，应当提示无效并递归提问，直到输入有效值为止', async () => {
      let callCount = 0;
      mockRlInterface.question = vi.fn().mockImplementation((_query: string, callback: (ans: string) => void) => {
        callCount++;
        if (callCount === 1) {
          callback('invalid');
        } else {
          callback('2');
        }
      });

      await handler('req-7', { name: 'run_cmd', arguments: {} });

      expect(mockSession.approvalService.resolve).toHaveBeenCalledWith('req-7', { action: 'deny' });
      expect(callCount).toBe(2);
      expect(getCleanedOutput()).toContain('无效选择，请重新输入');
    });
  });

  describe('BrowserSession.userInterventionHandler 浏览器风险协作回调', () => {
    it('触发干预回调时，应当正常挂起输入、等待用户确认并重新启动输入监听', async () => {
      const closeSpy = vi.spyOn(facade['listener'], 'close');
      const startSpy = vi.spyOn(facade['listener'], 'start');
      vi.mocked(waitUserIntervention).mockResolvedValue(undefined);

      // 直接调用被 Facade 注册在 BrowserSession 上的静态处理函数
      await BrowserSession.userInterventionHandler!('请确认浏览器操作');

      expect(closeSpy).toHaveBeenCalled();
      expect(waitUserIntervention).toHaveBeenCalledWith('请确认浏览器操作');
      expect(startSpy).toHaveBeenCalled();
    });

    it('即便 waitUserIntervention 抛出异常，也应当通过 finally 重新启动输入监听', async () => {
      const closeSpy = vi.spyOn(facade['listener'], 'close');
      const startSpy = vi.spyOn(facade['listener'], 'start');
      vi.mocked(waitUserIntervention).mockRejectedValue(new Error('Intervention timeout'));

      // 调用并期望其向上抛出或安全完成（原逻辑未 catch 错误，而是 try {} finally {}，所以异常会冒泡，但 finally 会执行）
      await expect(BrowserSession.userInterventionHandler!('请确认浏览器操作')).rejects.toThrow('Intervention timeout');

      expect(closeSpy).toHaveBeenCalled();
      expect(startSpy).toHaveBeenCalled();
    });
  });
});
