/**
 * 影窗周转（占台排期）核心算法测试。
 * 纯函数、以「分钟」为整数时间轴，不触碰 IndexedDB / React。
 */
import { describe, it, expect } from 'vitest';
import {
  baysOf,
  planRotation,
  EARLIEST_START_MIN,
  DEFAULT_CHANGEOVER_MIN,
  STANDARD_BAY_COUNT,
  type RotationSceneInput,
} from './screenRotation';

/** 构造场次输入的小工具 */
function scene(
  seq: number,
  durationMin: number,
  spec: RotationSceneInput['spec'] = 'standard',
  id = `s${seq}`,
): RotationSceneInput {
  return { id, seq, title: `第${seq}场`, durationMin, spec };
}

describe('baysOf 占台台数', () => {
  it('双联影窗占两台', () => {
    expect(baysOf('twin')).toBe(2);
  });

  it('小 / 标准 / 大影窗都占一台', () => {
    expect(baysOf('small')).toBe(1);
    expect(baysOf('standard')).toBe(1);
    expect(baysOf('large')).toBe(1);
  });

  it('没登记规格（undefined / 未知值）的旧场次按一台标准影窗算', () => {
    expect(baysOf(undefined)).toBe(1);
    expect(baysOf('something-old' as RotationSceneInput['spec'])).toBe(1);
    expect(baysOf(null)).toBe(1);
  });
});

describe('planRotation 基础周转', () => {
  it('常量：后台三台标准影窗、默认换景 15 分钟、零点开排', () => {
    expect(STANDARD_BAY_COUNT).toBe(3);
    expect(DEFAULT_CHANGEOVER_MIN).toBe(15);
    expect(EARLIEST_START_MIN).toBe(0);
  });

  it('一场标准影窗：开排即上台，结束后占满换景时间才释放', () => {
    const plan = planRotation({ scenes: [scene(1, 30)] });
    expect(plan.entries).toHaveLength(1);
    const e = plan.entries[0];
    expect(e.startMin).toBe(0);
    expect(e.endMin).toBe(30);
    expect(e.releaseMin).toBe(45);
    expect(e.bays).toEqual([1]);
    expect(e.delayed).toBe(false);
    expect(e.blockedBySceneIds).toEqual([]);
  });

  it('前三场各占一台标准影窗，同时 0 点开排（上一场没撤也轮得到下一场）', () => {
    const plan = planRotation({ scenes: [scene(1, 20), scene(2, 20), scene(3, 20)] });
    expect(plan.entries.map((e) => e.startMin)).toEqual([0, 0, 0]);
    expect(plan.entries.map((e) => e.bays)).toEqual([[1], [2], [3]]);
  });

  it('第四场容量不够，排队顺延到最早释放的一台，且写明被哪场占着', () => {
    // 场1 20分钟（0-20，35 释放 1 号窗）；场2 40分钟（0-40，55 释放 2 号窗）；场3 60分钟；场4 10分钟
    const plan = planRotation({
      scenes: [scene(1, 20), scene(2, 40), scene(3, 60), scene(4, 10)],
    });
    const e4 = plan.entries[3];
    expect(e4.startMin).toBe(35); // 场1 的 1 号窗换景结束
    expect(e4.bays).toEqual([1]);
    expect(e4.delayed).toBe(true);
    expect(e4.blockedBySceneIds).toContain('s1');
    // 顺延期间场2、场3 仍占着 2、3 号窗，也要写进占台说明
    expect(e4.blockedBySceneIds).toEqual(expect.arrayContaining(['s2', 's3']));
  });

  it('散场后留够换景时间才放给下一场：紧接的场次不得早于 release', () => {
    const four = planRotation({
      scenes: [scene(1, 30), scene(2, 30), scene(3, 30), scene(4, 30)],
      changeoverMin: 10,
    });
    expect(four.entries[3].startMin).toBe(40); // 30 散场 + 10 换景
    expect(four.entries[0].releaseMin - four.entries[0].endMin).toBe(10);
  });

  it('双联影窗一次占两台，第三台仍可上一场标准影窗', () => {
    const plan = planRotation({ scenes: [scene(1, 30, 'twin'), scene(2, 30, 'standard')] });
    expect(plan.entries[0].bays).toEqual([1, 2]);
    expect(plan.entries[1].bays).toEqual([3]);
    expect(plan.entries.every((e) => e.startMin === 0)).toBe(true);
  });

  it('双联影窗在只剩孤台时必须排队，顺延到凑齐相邻两台', () => {
    // 场1 双联占 1、2（0-10，换景 5 → 15 释放）；场2 标准占 3（0-100）
    // 场3 双联：15 时 1、2 同时空出，可上台
    const plan = planRotation({
      scenes: [scene(1, 10, 'twin'), scene(2, 100, 'standard'), scene(3, 10, 'twin')],
      changeoverMin: 5,
    });
    const e3 = plan.entries[2];
    expect(e3.startMin).toBe(15);
    expect(e3.bays).toEqual([1, 2]);
    expect(e3.delayed).toBe(true);
    expect(e3.blockedBySceneIds).toContain('s1');
  });

  it('两台空窗不相邻时，双联影窗顺延，并使用后释放出的相邻对', () => {
    // 场1 标准占 1（0-30，换景 5 → 35 释放）
    // 场2 双联占 2、3（0-10，换景 5 → 15 释放）
    // 场3 双联：15 时 1 号窗仍被场1 占着，2、3 恰好空出，故上台 2、3
    const plan = planRotation({
      scenes: [scene(1, 30, 'standard'), scene(2, 10, 'twin'), scene(3, 10, 'twin')],
      changeoverMin: 5,
    });
    expect(plan.entries[2].startMin).toBe(15);
    expect(plan.entries[2].bays).toEqual([2, 3]);
    expect(plan.entries[2].waitingForSceneIds).toEqual(['s2']);
  });

  it('单场所需窗位超过总台数时直接报错（双联在三窗环境内始终可排）', () => {
    expect(() =>
      planRotation({ scenes: [scene(1, 10, 'twin')], bayCount: 1 }),
    ).toThrowError(/窗位/);
  });

  it('只剩不相邻孤窗时，双联继续顺延到有相邻两台空出', () => {
    // 场1 占 1（0-30，换景 5 → 35 释放）；场2 占 2（0-20，换景 5 → 25 释放）；场3 占 3（0-100）
    // 场4 双联：25 时 2 号窗空，但 1 号 35 才放、3 号长占 → 35 时 1、2 相邻
    const plan = planRotation({
      scenes: [scene(1, 30), scene(2, 20), scene(3, 100), scene(4, 10, 'twin')],
      changeoverMin: 5,
    });
    const e4 = plan.entries[3];
    expect(e4.startMin).toBe(35);
    expect(e4.bays).toEqual([1, 2]);
    expect(e4.waitingForSceneIds).toEqual(['s1']);
    expect(e4.blockedBySceneIds).toEqual(expect.arrayContaining(['s1', 's2', 's3']));
  });
});

describe('planRotation 开排顺序与自定义参数', () => {
  it('严格按场序处理；乱序输入也会先排序', () => {
    const plan = planRotation({
      scenes: [scene(3, 10), scene(1, 10), scene(2, 10)],
    });
    expect(plan.entries.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('支持自定义开排时刻与换景时长', () => {
    const plan = planRotation({
      scenes: [scene(1, 30), scene(2, 30), scene(3, 30), scene(4, 30)],
      earliestStartMin: 120,
      changeoverMin: 20,
    });
    expect(plan.entries[0].startMin).toBe(120);
    expect(plan.entries[3].startMin).toBe(170); // 120 + 30 + 20
  });

  it('空场次表返回空账', () => {
    const plan = planRotation({ scenes: [] });
    expect(plan.entries).toEqual([]);
    expect(plan.finishMin).toBe(EARLIEST_START_MIN);
  });
});

describe('planRotation 顺延判定与散场时间', () => {
  it('finishMin 为全部影窗释放完毕（最后一次换景结束）的时刻', () => {
    const plan = planRotation({
      scenes: [scene(1, 20), scene(2, 50), scene(3, 50)],
      changeoverMin: 10,
    });
    expect(plan.finishMin).toBe(60); // max release = 50 + 10
  });

  it('被顺延场次的 waitingReason 指向决定其开排时刻的占台场', () => {
    const plan = planRotation({
      scenes: [scene(1, 20), scene(2, 40), scene(3, 60), scene(4, 10)],
      changeoverMin: 5,
    });
    const e4 = plan.entries[3];
    expect(e4.startMin).toBe(25); // 场1: 20 + 5
    expect(e4.waitingForSceneIds).toEqual(['s1']);
  });
});
