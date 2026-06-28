/**
 * @fileoverview CliFacade 的单元测试，用于验证 REPL 控制、门面路由及 UI 流式事件渲染。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import readline from 'readline';
import { EventEmitter } from 'events';
import { CliFacade } from '../../../../src/adapters/input/interface/facade.js';
import { SessionManager } from '../../../../src/core/usecases/engine/session.js';
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

class MockSessionManager extends EventEmitter {
  getIsGenerating = vi.fn().mockReturnValue(false);
  getModelName = vi.fn().mockReturnValue('mock-llama-3');
  getContext = vi.fn().mockReturnValue({
    getWorkMode: vi.fn().mockReturnValue('Auto')
  });
  abort = vi.fn();
  rollback = vi.fn();
  getHistory = vi.fn().mockReturnValue([]);
  getLastEstimatedUsage = vi.fn().mockReturnValue(null);
  getLastApiUsage = vi.fn().mockReturnValue(null);
  getSystemPromptHash = vi.fn().mockReturnValue('dummypromptmd5hash');
  close = vi.fn().mockResolvedValue(undefined);
  handleUserInput = vi.fn();
  approvalService = {
    registerApprovalHandler: vi.fn(),
    resolve: vi.fn(),
  };
}

describe('CliFacade', () => {
  let mockSession: SessionManager & {
    close: ReturnType<typeof vi.fn>;
    handleUserInput: ReturnType<typeof vi.fn>;
    rollback: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
    getLastEstimatedUsage: ReturnType<typeof vi.fn>;
    getLastApiUsage: ReturnType<typeof vi.fn>;
    getSystemPromptHash: ReturnType<typeof vi.fn>;
  };
  let facade: CliFacade;
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn> & { outputBuffer: string[] };
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let mockRlInterface: Record<string, unknown>;

  beforeEach(() => {
    mockSession = new MockSessionManager() as unknown as typeof mockSession;

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

    it('当输入以斜杠开头的自定义命令且不触发后续 LLM 交互时，应当直接调用并恢复输入监听', async () => {
      vi.mocked(dispatchCommand).mockResolvedValue(undefined);
      const onLineSubmit = facade['listener']['onLineSubmit'];
      
      const pauseSpy = vi.spyOn(facade['listener'], 'pause');
      const resumeSpy = vi.spyOn(facade['listener'], 'resume');

      await onLineSubmit('/help');

      expect(pauseSpy).toHaveBeenCalled();
      expect(dispatchCommand).toHaveBeenCalledWith('/help', expect.any(Object));
      expect(resumeSpy).toHaveBeenCalled();
    });

    it('当输入命令返回了需要与 LLM 交互的追加会话与沙盒技能时，应当提交交互并不恢复输入监听', async () => {
      vi.mocked(dispatchCommand).mockResolvedValue({
        transientSkillContent: 'sandbox code',
        userMessage: 'user command action'
      });
      const onLineSubmit = facade['listener']['onLineSubmit'];
      
      const pauseSpy = vi.spyOn(facade['listener'], 'pause');
      const resumeSpy = vi.spyOn(facade['listener'], 'resume');

      await onLineSubmit('/run-skill');

      expect(pauseSpy).toHaveBeenCalled();
      expect(mockSession.handleUserInput).toHaveBeenCalledWith('user command action', 'sandbox code');
      expect(resumeSpy).not.toHaveBeenCalled();
    });

    it('当输入单个斜杠启动交互菜单并退出时，不作任何提交且恢复输入监听', async () => {
      vi.mocked(showInteractiveMenu).mockResolvedValue(null);
      const onLineSubmit = facade['listener']['onLineSubmit'];
      
      const pauseSpy = vi.spyOn(facade['listener'], 'pause');
      const resumeSpy = vi.spyOn(facade['listener'], 'resume');

      await onLineSubmit('/');

      expect(pauseSpy).toHaveBeenCalled();
      expect(showInteractiveMenu).toHaveBeenCalled();
      expect(resumeSpy).toHaveBeenCalled();
    });

    it('当输入单个斜杠启动交互菜单并选择了有效指令时，应当重定向执行该指令', async () => {
      vi.mocked(showInteractiveMenu).mockResolvedValue('/help');
      vi.mocked(dispatchCommand).mockResolvedValue(undefined);
      const onLineSubmit = facade['listener']['onLineSubmit'];

      await onLineSubmit('/');

      expect(showInteractiveMenu).toHaveBeenCalled();
      expect(dispatchCommand).toHaveBeenCalledWith('/help', expect.any(Object));
    });

    it('当交互菜单抛出异常时，应当安全捕获并恢复输入监听', async () => {
      vi.mocked(showInteractiveMenu).mockRejectedValue(new Error('Menu crash'));
      const onLineSubmit = facade['listener']['onLineSubmit'];
      const resumeSpy = vi.spyOn(facade['listener'], 'resume');

      await onLineSubmit('/');

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
  });

  describe('approvalService.registerApprovalHandler 安全审批交互', () => {
    let handler: (
      id: string,
      toolCall: { name: string; arguments: Record<string, unknown> },
      allowedPrefix?: string,
      message?: string
    ) => Promise<void>;

    beforeEach(() => {
      handler = vi.mocked(mockSession.approvalService.registerApprovalHandler).mock.calls[0][0] as unknown as typeof handler;
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
      expect(mockSession.approvalService.resolve).toHaveBeenCalledWith('req-1', { action: 'once' });
      expect(startSpy).toHaveBeenCalledWith(true);
      
      const output = getCleanedOutput();
      expect(output).toContain('[安全提示] 测试警告');
      expect(output).toContain('dir');
    });

    it('当有 allowedPrefix 且用户输入 2 时，应当批准 always', async () => {
      mockRlInterface.question = vi.fn().mockImplementation((_query: string, callback: (ans: string) => void) => {
        callback('2');
      });

      await handler('req-2', { name: 'run_cmd', arguments: { command: 'dir' } }, 'dir');

      expect(mockSession.approvalService.resolve).toHaveBeenCalledWith('req-2', { action: 'always' });
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

      expect(mockSession.approvalService.resolve).toHaveBeenCalledWith('req-4', { action: 'once' });
      expect(callCount).toBe(2);
      expect(getCleanedOutput()).toContain('无效选择，请重新输入');
    });

    it('当无 allowedPrefix 且用户输入 1 时，应当批准 once', async () => {
      mockRlInterface.question = vi.fn().mockImplementation((_query: string, callback: (ans: string) => void) => {
        callback('1');
      });

      await handler('req-5', { name: 'run_cmd', arguments: {} });

      expect(mockSession.approvalService.resolve).toHaveBeenCalledWith('req-5', { action: 'once' });
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
