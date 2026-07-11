import { describe, expect, it, beforeAll } from 'vitest';
import {
  createDiagnosticTurnState,
  detectMeasuredEvidence,
  recordDiagnosticToolOutcome,
  reserveDiagnosticToolCall,
  checkDiagnosticConvergence,
  parseReadFileEvidence,
  parseListFilesEvidence,
  parseCommandEvidence,
  addEvidenceRecord,
  deriveEvidenceLevelFromRecords,
  MAX_EVIDENCE_RECORDS
} from '../../../src/core/domain/diagnostic-guardrails.js';
import type { DiagnosticEvidenceRecord, DiagnosticTurnState } from '../../../src/core/domain/diagnostic-guardrails.js';
import { registerDiagnosticEvidenceInterpreters } from '../../../src/adapters/tools/tool-factory.js';

describe('diagnostic-guardrails 结构化证据判定', () => {
  // 使用生产级别的注册链注册证据解释器，与 buildNativeTools 同构
  beforeAll(() => {
    registerDiagnosticEvidenceInterpreters();
  });

  it('普通 listFiles 枚举结果不应越级为 measured', () => {
    const state = createDiagnosticTurnState('请帮我诊断磁盘空间占用');
    // 无元数据的目录枚举返回 entries 列表但不含 size，应为 enumeration 级
    const nextState = recordDiagnosticToolOutcome(
      state,
      'listFiles',
      { targetPath: 'cache' },
      {
        result: JSON.stringify({
          targetPath: 'cache',
          entries: [
            { name: 'a.tmp', path: 'cache/a.tmp', kind: 'file', isDirectory: false },
            { name: 'sub', path: 'cache/sub', kind: 'directory', isDirectory: true }
          ]
        })
      }
    );

    expect(nextState.evidenceLevel).toBe('enumeration');
  });

  it('readFile 的辅助元数据不应被误判为 measured', () => {
    const hasMeasuredEvidence = detectMeasuredEvidence(
      'readFile',
      { targetPath: 'trace.log', includeMetadata: true },
      JSON.stringify({
        content: 'trace body',
        metadata: {
          sizeBytes: 2048,
          mtimeMs: 123456,
          lineCount: 88
        }
      })
    );

    expect(hasMeasuredEvidence).toBe(false);
  });

  it('listFiles 的结构化数量结果应提升为 measured', () => {
    const state = createDiagnosticTurnState('请帮我诊断磁盘空间占用');
    const nextState = recordDiagnosticToolOutcome(
      state,
      'listFiles',
      { targetPath: 'cache', includeMetadata: true },
      {
        result: JSON.stringify({
          targetPath: 'cache',
          entries: [
            { name: 'a.tmp', path: 'cache/a.tmp', kind: 'file', isDirectory: false, sizeBytes: 1024, mtimeMs: 1 },
            { name: 'sub', path: 'cache/sub', kind: 'directory', isDirectory: true, sizeBytes: null, mtimeMs: 2 }
          ]
        })
      }
    );

    expect(nextState.evidenceLevel).toBe('measured');
  });

  it('显式目录统计触发截断后，允许对后代目录更窄扫描（5.9）', () => {
    const state = createDiagnosticTurnState('请帮我诊断磁盘空间占用');
    const measuredState = recordDiagnosticToolOutcome(
      state,
      'listFiles',
      {
        targetPath: 'cache',
        includeDirectoryStats: true,
        maxDepth: 2,
        maxEntries: 100,
        maxBytes: 1024
      },
      {
        result: JSON.stringify({
          targetPath: 'cache',
          entries: [],
          directoryStats: {
            totalFiles: 10,
            totalDirectories: 3,
            totalSizeBytes: 8192,
            scannedEntries: 100,
            isTruncated: true,
            notice: '目录统计触发 maxEntries=100 限制，结果已截断。'
          }
        })
      }
    );

    // 后代目标 + 不扩大预算 → 允许
    const reservation = reserveDiagnosticToolCall(
      measuredState,
      'listFiles',
      {
        targetPath: 'cache/sub',
        maxEntries: 50
      }
    );

    expect(measuredState.lastDirectoryStatsTruncated).toBe(true);
    // 后代目标 + 不扩大预算 → 允许
    expect(reservation.blockedReason).toBeUndefined();
  });

  it('超过 listFiles 枚举预算后应阻断（5.8）', () => {
    let state = createDiagnosticTurnState('请帮我诊断磁盘空间占用');
    for (let i = 0; i < 4; i++) {
      const res = reserveDiagnosticToolCall(state, 'listFiles', { targetPath: `dir${i}` });
      state = res.state;
    }
    const final = reserveDiagnosticToolCall(state, 'listFiles', { targetPath: 'extra' });
    expect(final.blockedReason).toContain('枚举预算');
  });

  it('连续两次调用无新增证据后应在运行时阻断继续扩散', () => {
    const state = {
      ...createDiagnosticTurnState('请帮我诊断磁盘空间占用'),
      stagnantCallCount: 2,
    };

    const reservation = reserveDiagnosticToolCall(state, 'listFiles', { targetPath: '.' });

    expect(state.stagnantCallCount).toBe(2);
    expect(reservation.blockedReason).toContain('必须停止当前方向的扩散');
  });

  describe('对象级证据记录（5.13-5.14）', () => {
    it('parseReadFileEvidence 应解析 sizeBytes 和 lineCount 为 complete，mtimeMs 为 partial', () => {
      const records = parseReadFileEvidence(
        'test.txt',
        JSON.stringify({
          content: 'test',
          metadata: { sizeBytes: 1024, lineCount: 10, mtimeMs: 123456 }
        })
      );

      const sizeRecord = records.find(r => r.metric === 'sizeBytes');
      expect(sizeRecord).toBeDefined();
      expect(sizeRecord!.value).toBe(1024);
      expect(sizeRecord!.completeness).toBe('complete');
      expect(sizeRecord!.target).toBe('test.txt');

      const lineRecord = records.find(r => r.metric === 'lineCount');
      expect(lineRecord).toBeDefined();
      expect(lineRecord!.value).toBe(10);

      const mtimeRecord = records.find(r => r.metric === 'mtimeMs');
      expect(mtimeRecord).toBeDefined();
      expect(mtimeRecord!.completeness).toBe('partial');
    });

    it('parseListFilesEvidence 应解析 entries 中的文件 size', () => {
      const records = parseListFilesEvidence(
        'testdir',
        JSON.stringify({
          targetPath: 'testdir',
          entries: [
            { name: 'a.txt', sizeBytes: 512 },
            { name: 'b.txt', sizeBytes: 256 }
          ]
        })
      );

      expect(records.length).toBeGreaterThanOrEqual(2);
    });

    it('parseCommandEvidence 应提取查询命令中的数量证据', () => {
      const records = parseCommandEvidence('wmic logicaldisk', 'size: 500GB free');
      expect(records.length).toBeGreaterThanOrEqual(1);
    });

    it('addEvidenceRecord 应在超出上限时淘汰低优先级记录', () => {
      const records: DiagnosticEvidenceRecord[] = [];
      for (let i = 0; i < MAX_EVIDENCE_RECORDS + 5; i++) {
        records.push({
          target: `file${i}`,
          metric: 'sizeBytes',
          value: i,
          unit: 'bytes',
          source: 'test',
          completeness: 'partial',
          coverage: `file${i}`
        });
      }
      const result = addEvidenceRecord(records.slice(0, MAX_EVIDENCE_RECORDS), records[MAX_EVIDENCE_RECORDS]);
      expect(result.length).toBeLessThanOrEqual(MAX_EVIDENCE_RECORDS);
    });

    it('deriveEvidenceLevelFromRecords 应正确派生等级', () => {
      const records: DiagnosticEvidenceRecord[] = [
        { target: 'test', metric: 'size', value: 100, unit: 'bytes', source: 'test', completeness: 'complete', coverage: 'test' }
      ];
      expect(deriveEvidenceLevelFromRecords(records)).toBe('measured');

      expect(deriveEvidenceLevelFromRecords([])).toBe('presence');

      const errorRecords: DiagnosticEvidenceRecord[] = [
        { target: 'test', metric: 'error', value: 0, unit: '', source: 'test', completeness: 'partial', coverage: '', error: 'failed' }
      ];
      expect(deriveEvidenceLevelFromRecords(errorRecords)).toBe('error');
    });
  });

  describe('browser_navigate 诊断阻断', () => {
    it('系统查询失败后的 browser_navigate(file://) 应被 reserve 拒绝', () => {
      const state = createDiagnosticTurnState('请帮我诊断磁盘空间占用');
      state.lastSystemQueryFailed = true;

      const reservation = reserveDiagnosticToolCall(state, 'browser_navigate', { url: 'file:///C:/Users' });

      expect(reservation.blockedReason).toBeDefined();
      expect(reservation.blockedReason).toContain('不允许浏览器导航');
    });

    it('非 file:// 的 browser_navigate 放行', () => {
      const state = createDiagnosticTurnState('请帮我诊断磁盘空间占用');

      const reservation = reserveDiagnosticToolCall(state, 'browser_navigate', { url: 'https://example.com' });

      expect(reservation.blockedReason).toBeUndefined();
    });

    it('非诊断上下文中 browser_navigate(file://) 放行', () => {
      const state = createDiagnosticTurnState('帮我查一下今天的天气');

      const reservation = reserveDiagnosticToolCall(state, 'browser_navigate', { url: 'file:///C:/temp/report.html' });

      expect(reservation.blockedReason).toBeUndefined();
    });
  });

  describe('低增益停机', () => {
    it('连续 3 次无新增证据应被收敛检查阻断', () => {
      const state: DiagnosticTurnState = {
        active: true,
        evidenceLevel: 'enumeration',
        systemQueryAttempts: 0,
        lastSystemQueryFailed: false,
        listFilesUsed: 0,
        stagnantListFilesCount: 0,
        lastDirectoryStatsTruncated: false,
        highRiskTargets: [],
        scannedTargets: ['dir1', 'dir2'],
        evidenceRecords: [],
        callMetrics: [],
        stagnantCallCount: 3,
        stagnantTargetCount: 0
      };

      const reason = checkDiagnosticConvergence(state, 'listFiles', 'dir3');
      expect(reason).toBeDefined();
      expect(reason).toContain('连续');
      expect(reason).toContain('无新增证据');
    });

    it('有效窄化（新目标 + 新证据）后停滞计数应重置', () => {
      let state = createDiagnosticTurnState('请诊断磁盘空间占用');
      // 第一次调用，产生新证据
      state = recordDiagnosticToolOutcome(
        state, 'listFiles', { targetPath: 'cache' },
        { result: JSON.stringify({ targetPath: 'cache', entries: [{ name: 'a.tmp' }] }) }
      );
      expect(state.stagnantCallCount).toBe(0); // 正常调用，有 evidenceGain

      // 第二次对不同目录调用
      state = recordDiagnosticToolOutcome(
        state, 'listFiles', { targetPath: 'other' },
        { result: JSON.stringify({ targetPath: 'other', entries: [{ name: 'b.log' }] }) }
      );
      expect(state.stagnantCallCount).toBe(0);
    });

    it('局部 error 不应清除其他对象的 measured 记录', () => {
      let state = createDiagnosticTurnState('请诊断磁盘空间占用');
      // 先建立一条 complete measured 记录
      state.evidenceRecords = [{
        target: 'C:\\data', metric: 'totalSize', value: 500000000,
        unit: 'bytes', source: 'listFiles', completeness: 'complete',
        coverage: 'C:\\data'
      }];
      state.evidenceLevel = 'measured';

      // 再出现一个无关的局部 error（不同目标）
      state = recordDiagnosticToolOutcome(
        state, 'listFiles', { targetPath: 'other' },
        { error: '权限不足', result: undefined }
      );

      // 原有的 measured 记录应仍保留，不应被 error 清除
      expect(state.evidenceRecords.some(r => r.target === 'C:\\data' && r.metric === 'totalSize')).toBe(true);
      // 局部 error 不丢失已有精确记录（error 是回合级最高优先等级，但对象级记录保留）
      expect(state.evidenceRecords.filter(r => r.target === 'C:\\data').length).toBe(1);
    });
  });
});
