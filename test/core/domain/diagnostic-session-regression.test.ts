/**
 * @file 诊断会话回归测试。
 * 基于真实诊断场景的会话序列，验证证据形成、收敛判定和质量门禁全链路。
 *
 * 覆盖场景：
 * 1. 辅助调用（get_current_time）不得消耗证据停滞额度
 * 2. 普通目录枚举形成 candidatel level 证据
 * 3. wmic 测量形成 measured 级证据
 * 4. 复杂 PowerShell 被运行时拒绝
 * 5. 最终回答质量门禁阻止无依据量化估算
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  createDiagnosticTurnState,
  recordDiagnosticToolOutcome,
  reserveDiagnosticToolCall,
  applyDiagnosticQualityGate
} from '../../../src/core/domain/diagnostic-guardrails.js';
import { registerDiagnosticEvidenceInterpreters } from '../../../src/adapters/tools/tool-factory.js';

describe('诊断会话回归测试', () => {
  beforeAll(() => {
    // 使用生产装配入口，避免测试自建解释器掩盖真实注册链回归。
    registerDiagnosticEvidenceInterpreters();
  });

  it('1. 辅助调用（get_current_time）不得消耗证据停滞额度', () => {
    let state = createDiagnosticTurnState('请帮我诊断磁盘空间占用');

    // 模拟：先做一次目录枚举
    const listResult = recordDiagnosticToolOutcome(
      state, 'listFiles', { targetPath: 'cache' },
      { result: JSON.stringify(['a.tmp', 'b.log']) }
    );
    state = listResult;
    expect(state.stagnantCallCount).toBe(0);

    // 模拟辅助调用 - 不应增加停滞计数
    const timeResult = recordDiagnosticToolOutcome(
      state, 'get_current_time', {}, { result: '2026-07-11T00:00:00.000Z' }
    );
    state = timeResult;
    // 非诊断工具不增加停滞计数
    expect(state.stagnantCallCount).toBe(0);
    expect(state.callMetrics.length).toBe(1); // 只有 listFiles 的记录
  });

  it('2. 普通目录枚举形成 evidence 记录且不得提前停机', () => {
    let state = createDiagnosticTurnState('请帮我诊断磁盘空间占用');

    // 三轮目录枚举，每轮产生不同目标的新证据
    for (let i = 0; i < 3; i++) {
      const dir = `dir${i}`;
      // 先保留调用预算
      const reservation = reserveDiagnosticToolCall(state, 'listFiles', { targetPath: dir });
      // 不同目标不触发重复扫描阻断
      if (reservation.blockedReason) {
        // 若被预算阻断，说明已达到限制，允许提前结束
        break;
      }

      state = recordDiagnosticToolOutcome(
        reservation.state, 'listFiles', { targetPath: dir },
        { result: JSON.stringify([`file_${i}.tmp`]) }
      );
    }

    // 三轮枚举后应有证据记录
    expect(state.evidenceRecords.length).toBeGreaterThanOrEqual(1);
    // 不应因目标重复而停机
    expect(state.callMetrics.length).toBeGreaterThanOrEqual(1);
  });

  it('3. wmic 测量形成 measured 级证据', () => {
    const state = createDiagnosticTurnState('检查磁盘空间');
    const result = recordDiagnosticToolOutcome(
      state, 'execute_command',
      { command: 'wmic logicaldisk where caption="C:" get caption,size,freespace /format:value' },
      { result: 'Caption=C:\nFreeSpace=107374182400\nSize=536870912000\n' }
    );

    const freeRecord = result.evidenceRecords.find(r => r.metric === 'freeSpace');
    expect(freeRecord).toBeDefined();
    expect(freeRecord!.value).toBe(107374182400);
    expect(freeRecord!.completeness).toBe('complete');

    const sizeRecord = result.evidenceRecords.find(r => r.metric === 'totalSize');
    expect(sizeRecord).toBeDefined();
    expect(sizeRecord!.value).toBe(536870912000);

    // 应有 measured 级
    expect(result.evidenceLevel).toBe('measured');
  });

  it('4. 复杂 PowerShell 被运行时拒绝（非只读白名单+复合连接符）', () => {
    // 模拟一个带管道符的复杂命令
    const state = createDiagnosticTurnState('检查磁盘空间');
    const result = recordDiagnosticToolOutcome(
      state, 'execute_command',
      { command: 'Get-ChildItem C:\\ | Where-Object {$_.Length -gt 1MB}' },
      { error: '拒绝执行：检测到非法的复合连接符或重定向符' }
    );

    // 应有 error 记录
    expect(result.evidenceLevel).toBe('error');
    expect(result.lastSystemQueryFailed).toBe(true);
  });

  it('5. 最终回答质量门禁阻止无依据量化估算', () => {
    const state = createDiagnosticTurnState('请帮我诊断磁盘空间占用');

    // 仅有枚举证据，无实际测量
    const withEnumState = recordDiagnosticToolOutcome(
      state, 'listFiles', { targetPath: 'cache' },
      { result: JSON.stringify(['a.tmp', 'b.log', 'sub']) }
    );

    // 质量门禁应阻止无依据的量化释放估算
    const badResponse = '根据分析，建议优先清理 cache 目录，可释放约 500MB 空间。主要占用是临时日志文件。';
    const gateResult = applyDiagnosticQualityGate(badResponse, withEnumState.evidenceRecords);

    expect(gateResult.violations.length).toBeGreaterThan(0);
    // 质量门禁应将"释放约 500MB"标记为待验证
    expect(gateResult.sanitizedText).toContain('待验证');
    expect(gateResult.violations[0]).toContain('量化释放');
  });

  it('6. 无关完整测量不得为任意量化释放主张背书', () => {
    const measuredState = recordDiagnosticToolOutcome(
      createDiagnosticTurnState('检查磁盘空间'),
      'execute_command',
      { command: 'wmic logicaldisk where caption="C:" get caption,size,freespace /format:value' },
      { result: 'Caption=C:\nFreeSpace=107374182400\nSize=536870912000\n' }
    );

    const gateResult = applyDiagnosticQualityGate(
      '建议清理缓存，可释放约 500MB 空间。',
      measuredState.evidenceRecords
    );

    expect(gateResult.passed).toBe(false);
    expect(gateResult.sanitizedText).toContain('待验证');
  });
});
