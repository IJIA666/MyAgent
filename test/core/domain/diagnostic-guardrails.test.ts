import { describe, expect, it, beforeAll } from 'vitest';
import {
  createDiagnosticTurnState,
  detectMeasuredEvidence,
  recordDiagnosticToolOutcome,
  reserveDiagnosticToolCall,
  parseReadFileEvidence,
  parseListFilesEvidence,
  parseCommandEvidence,
  addEvidenceRecord,
  deriveEvidenceLevelFromRecords,
  MAX_EVIDENCE_RECORDS
} from '../../../src/core/domain/diagnostic-guardrails.js';
import type { DiagnosticEvidenceRecord } from '../../../src/core/domain/diagnostic-guardrails.js';
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
});
