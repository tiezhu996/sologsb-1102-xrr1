/**
 * 影窗周转账（落库 / 重算 / 失败重试）测试。
 * 用内存 Sink 模拟 IndexedDB，可注入写失败。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  rotationFingerprint,
  buildRotationPlan,
  commitRotationPlan,
  loadRotationState,
  isPlanStale,
  scenesFingerprint,
  type RotationSink,
  type RotationSettings,
  type LedgerEntry,
  type PlannedEntry,
} from './rotationLedger';
import type { RotationSceneInput } from './screenRotation';
import type { SceneRow } from './db';

const SETTINGS: RotationSettings = { earliestStartMin: 0, changeoverMin: 15 };

function scene(
  seq: number,
  durationMin: number,
  spec: RotationSceneInput['spec'] = 'standard',
  id = `s${seq}`,
): RotationSceneInput {
  return { id, seq, title: `第${seq}场`, durationMin, spec };
}

/** 由精简输入造 SceneRow 形状（算法只关心少数字段） */
function row(input: RotationSceneInput): SceneRow {
  return {
    id: input.id,
    playId: 'p1',
    seq: input.seq,
    title: input.title,
    durationMin: input.durationMin,
    stageNote: '',
    needsShadowScreen: (input.spec ?? 'standard') as SceneRow['needsShadowScreen'],
    progress: 0,
    createdAt: '',
    updatedAt: '',
    revision: 2,
  };
}

/** 旧场次：库里压根没有 needsShadowScreen 字段 */
function legacyRow(seq: number, durationMin: number, id = `s${seq}`): SceneRow {
  const r = row(scene(seq, durationMin, undefined, id));
  delete (r as Partial<SceneRow>).needsShadowScreen;
  return r;
}

/** 可注入失败次数的内存账台 */
class MemorySink implements RotationSink {
  rows = new Map<string, LedgerEntry>();
  failNext = 0;
  appended: string[] = [];

  async appendEntry(entry: LedgerEntry): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('写账失败（模拟 IndexedDB 异常）');
    }
    this.rows.set(entry.sceneId, entry);
    this.appended.push(entry.sceneId);
  }

  async listByPlay(playId: string): Promise<LedgerEntry[]> {
    return [...this.rows.values()]
      .filter((item) => item.playId === playId)
      .sort((a, b) => a.seq - b.seq);
  }
}

describe('rotationFingerprint 输入指纹', () => {
  it('时长、顺序或规格任一变化都会改变指纹', () => {
    const base = scene(1, 30, 'standard');
    expect(rotationFingerprint(scene(1, 31, 'standard'))).not.toBe(rotationFingerprint(base));
    expect(rotationFingerprint(scene(1, 30, 'twin'))).not.toBe(rotationFingerprint(base));
    expect(rotationFingerprint({ ...base, seq: 2 })).not.toBe(rotationFingerprint(base));
  });

  it('标题变化不影响周转指纹（周转不关心标题）', () => {
    expect(rotationFingerprint(scene(1, 30, 'standard'))).toBe(
      rotationFingerprint({ ...scene(1, 30, 'standard'), title: '改名' }),
    );
  });

  it('缺规格旧场次与显式 standard 指纹相同（都按一台标准影窗算）', () => {
    expect(rotationFingerprint(scene(1, 30, undefined))).toBe(
      rotationFingerprint(scene(1, 30, 'standard')),
    );
  });
});

describe('buildRotationPlan 未开排周转重算', () => {
  it('无已确认账时，整轮按当前场次重算', () => {
    const scenes = [row(scene(1, 20)), row(scene(2, 40)), row(scene(3, 60)), row(scene(4, 10))];
    const result = buildRotationPlan('p1', scenes, SETTINGS, []);
    expect(result.entries.map((e) => e.sceneId)).toEqual(['s1', 's2', 's3', 's4']);
    expect(result.entries[3].startMin).toBe(35);
    expect(result.entries[3].blockedBySceneIds).toEqual(expect.arrayContaining(['s1', 's2', 's3']));
    expect(result.confirmedSceneIds).toEqual([]);
    expect(result.entries.every((e) => e.status === 'planned')).toBe(true);
  });

  it('已确认场次锁定为固定占台，只重算其后未开排部分', () => {
    // 先确认场1（双联 20 分钟，0-20 / 35 释放 1、2 窗）与场2（3 号窗 0-20）
    const first = [row(scene(1, 20, 'twin')), row(scene(2, 20, 'standard')), row(scene(3, 20, 'standard'))];
    const initial = buildRotationPlan('p1', first, SETTINGS, []);
    const confirmedRows: LedgerEntry[] = [initial.entries[0], initial.entries[1]].map((e) =>
      toLedgerEntry('p1', e, SETTINGS),
    );

    // 场3 时长改成 50：场1、场2 已开排不动；场3 作废重算
    const changed = [
      row(scene(1, 20, 'twin')),
      row(scene(2, 20, 'standard')),
      row(scene(3, 50, 'standard')),
    ];
    const rebuilt = buildRotationPlan('p1', changed, SETTINGS, confirmedRows);
    expect(rebuilt.confirmedSceneIds).toEqual(['s1', 's2']);
    const e1 = rebuilt.entries[0];
    const e2 = rebuilt.entries[1];
    expect(e1.status).toBe('confirmed');
    expect(e1.startMin).toBe(0);
    expect(e1.bays).toEqual([1, 2]);
    expect(e2.status).toBe('confirmed');
    // 场3 重算：1、2 窗 35 释放；3 号窗 35 释放（场2 20+15），故 35 上台
    const e3 = rebuilt.entries[2];
    expect(e3.status).toBe('planned');
    expect(e3.startMin).toBe(35);
    expect(e3.endMin).toBe(85);
    expect(e3.delayed).toBe(true);
    expect(e3.blockedBySceneIds).toEqual(expect.arrayContaining(['s1', 's2']));
  });

  it('没登记规格的旧场次按标准影窗（一台）占台', () => {
    const result = buildRotationPlan(
      'p1',
      [legacyRow(1, 30), legacyRow(2, 30), legacyRow(3, 30), legacyRow(4, 30)],
      SETTINGS,
      [],
    );
    expect(result.entries[3].delayed).toBe(true);
    expect(result.entries[3].startMin).toBe(45);
    expect(result.entries.every((e) => e.spec === 'standard' && e.bays.length === 1)).toBe(true);
  });

  it('场次删掉后，已确认账里不再存在的场次被忽略', () => {
    const first = [row(scene(1, 20)), row(scene(2, 20)), row(scene(3, 20))];
    const initial = buildRotationPlan('p1', first, SETTINGS, []);
    const confirmedRows = [toLedgerEntry('p1', initial.entries[0], SETTINGS)];
    // 删掉场2，原场3 升为第 2 场
    const remaining = [row(scene(1, 20)), { ...row(scene(3, 20)), seq: 2 }];
    const rebuilt = buildRotationPlan('p1', remaining, SETTINGS, confirmedRows);
    expect(rebuilt.entries.map((e) => e.sceneId)).toEqual(['s1', 's3']);
    expect(rebuilt.entries[0].status).toBe('confirmed');
    expect(rebuilt.entries[1].status).toBe('planned');
  });
});

/** 把计划行包装成账台存储行形状 */
function toLedgerEntry(playId: string, e: PlannedEntry, settings: RotationSettings): LedgerEntry {
  return {
    playId,
    sceneId: e.sceneId,
    seq: e.seq,
    title: e.title,
    spec: e.spec,
    bays: e.bays,
    startMin: e.startMin,
    endMin: e.endMin,
    releaseMin: e.releaseMin,
    delayed: e.delayed,
    blockedBySceneIds: e.blockedBySceneIds,
    waitingForSceneIds: e.waitingForSceneIds,
    inputFingerprint: e.inputFingerprint,
    settings,
    confirmedAt: '2026-10-03T00:00:00.000Z',
  };
}

describe('isPlanStale 改动作废', () => {
  it('场次时长、顺序或规格改动后，未开排的周转指纹对不上 → 作废重算', () => {
    const rows3 = [row(scene(1, 20)), row(scene(2, 20)), row(scene(3, 20))];
    const saved = scenesFingerprint(rows3);
    expect(isPlanStale(rows3, [], saved)).toBe(false);
    expect(isPlanStale([row(scene(1, 25)), row(scene(2, 20)), row(scene(3, 20))], [], saved)).toBe(true);
    // 调序
    const reordered = [row(scene(1, 20)), { ...row(scene(2, 20)), id: 's3' }, { ...row(scene(3, 20)), id: 's2' }];
    expect(isPlanStale(reordered, [], saved)).toBe(true);
    // 改规格
    expect(isPlanStale([row(scene(1, 20, 'twin')), row(scene(2, 20)), row(scene(3, 20))], [], saved)).toBe(true);
    // 从未算过（null）→ 必算
    expect(isPlanStale(rows3, [], null)).toBe(true);
  });

  it('已确认场次的指纹即使与当前输入不符也不作废（开排即锁定）', () => {
    const initial = buildRotationPlan(
      'p1',
      [row(scene(1, 20)), row(scene(2, 20))],
      SETTINGS,
      [],
    );
    const confirmedRows = [toLedgerEntry('p1', initial.entries[0], SETTINGS)];
    // 场1 时长已改，但它已开排 → 已确认行仍有效，只有场2 重算
    const changed = [row(scene(1, 99)), row(scene(2, 20))];
    const rebuilt = buildRotationPlan('p1', changed, SETTINGS, confirmedRows);
    expect(rebuilt.entries[0].status).toBe('confirmed');
    expect(rebuilt.entries[0].endMin).toBe(20); // 锁定旧账
  });
});

describe('commitRotationPlan 写账与重试', () => {
  let sink: MemorySink;
  beforeEach(() => {
    sink = new MemorySink();
  });

  it('按场序逐场写账，记录已确认到哪一场', async () => {
    const plan = buildRotationPlan(
      'p1',
      [row(scene(1, 20)), row(scene(2, 20)), row(scene(3, 20))],
      SETTINGS,
      [],
    );
    const result = await commitRotationPlan(plan, sink, { playId: 'p1', settings: SETTINGS, upToSceneSeq: 2 });
    expect(result.ok).toBe(true);
    expect(result.written).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.lastConfirmedSeq).toBe(2);
    expect(sink.appended).toEqual(['s1', 's2']);
  });

  it('写账第一场就失败：零确认；重试从头补写，同场不重复占台', async () => {
    const plan = buildRotationPlan(
      'p1',
      [row(scene(1, 20)), row(scene(2, 20)), row(scene(3, 20)), row(scene(4, 20))],
      SETTINGS,
      [],
    );
    sink.failNext = 1;
    const failed = await commitRotationPlan(plan, sink, { playId: 'p1', settings: SETTINGS, upToSceneSeq: 3 });
    expect(failed.ok).toBe(false);
    expect(failed.written).toBe(0);
    expect(failed.lastConfirmedSeq).toBe(0);
    expect(failed.failedSceneId).toBe('s1');

    const retry = await commitRotationPlan(plan, sink, { playId: 'p1', settings: SETTINGS, upToSceneSeq: 3 });
    expect(retry.ok).toBe(true);
    expect(retry.written).toBe(3);
    expect(retry.lastConfirmedSeq).toBe(3);
    expect(sink.appended).toEqual(['s1', 's2', 's3']);
  });

  it('同一场不重复占台：已确认的场次跳过重写', async () => {
    const plan = buildRotationPlan(
      'p1',
      [row(scene(1, 20)), row(scene(2, 20)), row(scene(3, 20))],
      SETTINGS,
      [],
    );
    await commitRotationPlan(plan, sink, { playId: 'p1', settings: SETTINGS, upToSceneSeq: 2 });
    sink.appended = [];
    const again = await commitRotationPlan(plan, sink, { playId: 'p1', settings: SETTINGS, upToSceneSeq: 3 });
    expect(again.ok).toBe(true);
    expect(again.written).toBe(1);
    expect(again.skipped).toBe(2);
    expect(sink.appended).toEqual(['s3']);
  });

  it('失败发生在第 2 场：第 1 场已落账；重试接着最后确认的一场往下走', async () => {
    const plan = buildRotationPlan(
      'p1',
      [row(scene(1, 20)), row(scene(2, 20)), row(scene(3, 20))],
      SETTINGS,
      [],
    );
    await commitRotationPlan(plan, sink, { playId: 'p1', settings: SETTINGS, upToSceneSeq: 1 });
    sink.failNext = 1; // s2 写失败
    sink.appended = [];
    const failed = await commitRotationPlan(plan, sink, { playId: 'p1', settings: SETTINGS, upToSceneSeq: 3 });
    expect(failed.ok).toBe(false);
    expect(failed.written).toBe(0);
    expect(failed.lastConfirmedSeq).toBe(1);
    expect(failed.failedSceneId).toBe('s2');

    const retry = await commitRotationPlan(plan, sink, { playId: 'p1', settings: SETTINGS, upToSceneSeq: 3 });
    expect(retry.ok).toBe(true);
    expect(retry.written).toBe(2); // s2、s3
    expect(retry.skipped).toBe(1); // s1 已确认，跳过
    expect(sink.appended).toEqual(['s2', 's3']);
  });
});

describe('loadRotationState 断点恢复', () => {
  it('从账台读出已确认场次，作为固定占台继续往下排', async () => {
    const sink = new MemorySink();
    const scenes = [row(scene(1, 20)), row(scene(2, 20)), row(scene(3, 20)), row(scene(4, 20))];
    const plan = buildRotationPlan('p1', scenes, SETTINGS, []);
    await commitRotationPlan(plan, sink, { playId: 'p1', settings: SETTINGS, upToSceneSeq: 2 });

    const state = await loadRotationState('p1', scenes, SETTINGS, sink);
    expect(state.confirmedEntries.map((e) => e.sceneId)).toEqual(['s1', 's2']);
    expect(state.plan.entries.map((e) => e.sceneId)).toEqual(['s1', 's2', 's3', 's4']);
    expect(state.plan.entries.slice(0, 2).every((e) => e.status === 'confirmed')).toBe(true);
    expect(state.plan.entries.slice(2).every((e) => e.status === 'planned')).toBe(true);
  });
});
