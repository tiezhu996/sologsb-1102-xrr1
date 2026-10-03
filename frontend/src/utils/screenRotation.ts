/**
 * 影窗周转（占台排期）纯算法。
 *
 * 规则：
 * - 后台固定三台「标准影窗」窗位（编号 1-3）；任一场按登记的影窗规格占台：
 *   双联影窗占两台相邻窗位，其余规格（小/标准/大）各占一台。
 * - 没登记规格的旧场次，按一台标准影窗算。
 * - 按开排顺序（场序）逐场占台；前三台没撤，后一场只要还有空窗位即可同时上台。
 * - 每场散场后保留「换景时间」，窗位在换景结束后才释放给下一场。
 * - 窗位容量不够（双联凑不齐相邻两台也算不够）就排队顺延：开排时刻不早于
 *   上一场开排时刻，并记明被哪场占着、等到哪场散场换景完毕。
 */
import type { ShadowScreenSpec } from '../types/scene';

/** 后台标准影窗窗位总数 */
export const STANDARD_BAY_COUNT = 3;
/** 默认换景时间（分钟） */
export const DEFAULT_CHANGEOVER_MIN = 15;
/** 默认开排时刻（从零点起的分钟数） */
export const EARLIEST_START_MIN = 0;

/** 占台计算时接受的影窗规格：缺省/未知一律按标准影窗（一台）处理 */
export type RotationScreenSpec = ShadowScreenSpec | null | undefined | string;

/** 参与周转计算的场次（只取算法需要的字段） */
export interface RotationSceneInput {
  id: string;
  seq: number;
  title: string;
  durationMin: number;
  spec: RotationScreenSpec;
}

/** 单场占台账行 */
export interface RotationEntry {
  sceneId: string;
  seq: number;
  title: string;
  /** 实际按哪种规格占的台（缺省规格已兜底为 standard） */
  spec: ShadowScreenSpec;
  /** 占用的窗位编号（双联两台） */
  bays: number[];
  /** 开排时刻（分钟） */
  startMin: number;
  /** 散场时刻（分钟） */
  endMin: number;
  /** 窗位释放时刻 = 散场 + 换景（分钟） */
  releaseMin: number;
  /** 是否因容量不足排队顺延过 */
  delayed: boolean;
  /** 最初可开排时刻正在占台的场次（写明被哪场占着） */
  blockedBySceneIds: string[];
  /** 决定最终开排时刻的关键占台场（其换景结束后才轮到本场） */
  waitingForSceneIds: string[];
}

/** 一整轮周转账 */
export interface RotationPlan {
  entries: RotationEntry[];
  /** 全部窗位释放完毕的时刻（最后一次换景结束） */
  finishMin: number;
  earliestStartMin: number;
  changeoverMin: number;
  bayCount: number;
}

export interface PlanRotationOptions {
  scenes: RotationSceneInput[];
  /** 开排起点（分钟），默认 0 */
  earliestStartMin?: number;
  /** 换景时间（分钟），默认 15 */
  changeoverMin?: number;
  /** 窗位总数，默认 3（主要便于测试） */
  bayCount?: number;
}

interface BayInterval {
  bay: number;
  startMin: number;
  releaseMin: number;
  sceneId: string;
}

/** 某规格占几台标准影窗；双联两台，其余（含缺省/未知）一台 */
export function baysOf(spec: RotationScreenSpec): number {
  return spec === 'twin' ? 2 : 1;
}

/** 把缺省/未知规格兜底为标准影窗 */
function normalizeSpec(spec: RotationScreenSpec): ShadowScreenSpec {
  if (spec === 'small' || spec === 'standard' || spec === 'large' || spec === 'twin') {
    return spec;
  }
  return 'standard';
}

/** 判断某时刻某窗位是否仍被占用（半开区间：[start, release)） */
function isBusyAt(interval: BayInterval | undefined, t: number): boolean {
  return !!interval && interval.startMin <= t && t < interval.releaseMin;
}

/** 在占用表上找出 t 时刻最早的一段连续 k 个空闲窗位（按编号从小到大），返回窗位编号 */
function findFreeRun(
  occupancy: Array<BayInterval | undefined>,
  t: number,
  need: number,
  bayCount: number,
): number[] | null {
  let run: number[] = [];
  for (let bay = 1; bay <= bayCount; bay += 1) {
    if (isBusyAt(occupancy[bay - 1], t)) {
      run = [];
    } else {
      run.push(bay);
      if (run.length === need) return run;
    }
  }
  return null;
}

/**
 * 按开排顺序计算影窗周转账。
 * 纯函数：同样输入永远得到同样输出，不落库。
 */
export function planRotation(options: PlanRotationOptions): RotationPlan {
  const { scenes } = options;
  const earliestStartMin = options.earliestStartMin ?? EARLIEST_START_MIN;
  const changeoverMin = Math.max(0, options.changeoverMin ?? DEFAULT_CHANGEOVER_MIN);
  const bayCount = options.bayCount ?? STANDARD_BAY_COUNT;

  const ordered = [...scenes].sort((a, b) => a.seq - b.seq);
  if (ordered.some((item) => baysOf(item.spec) > bayCount)) {
    throw new Error(`影窗规格所需窗位超过台口容量（共 ${bayCount} 台标准影窗），无法占台`);
  }
  // 每个窗位一条占用链；FIFO 下每窗位至多有一条已登记占用
  const occupancy: Array<BayInterval | undefined> = new Array(bayCount).fill(undefined);
  const entries: RotationEntry[] = [];

  /** t 时刻仍在占台的占用记录 */
  const busyAt = (t: number): BayInterval[] =>
    occupancy.filter((item): item is BayInterval => isBusyAt(item, t));

  for (const sceneInput of ordered) {
    const spec = normalizeSpec(sceneInput.spec);
    const need = baysOf(spec);
    const durationMin = Math.max(0, sceneInput.durationMin);

    // 严格排队：不早于上一场的开排时刻
    const initialReadyAt =
      entries.length === 0
        ? earliestStartMin
        : Math.max(earliestStartMin, entries[entries.length - 1].startMin);

    const blockersAtReady = busyAt(initialReadyAt);
    const blockedBySceneIds = [...new Set(blockersAtReady.map((item) => item.sceneId))];

    // 容量不足就沿「最早释放时刻」一次次往后顺延，直到凑齐连续窗位
    let startMin = initialReadyAt;
    let waitingForSceneIds: string[] = [];
    let run = findFreeRun(occupancy, startMin, need, bayCount);
    while (!run) {
      const busy = busyAt(startMin);
      const nextRelease = Math.min(...busy.map((item) => item.releaseMin));
      waitingForSceneIds = [...new Set(busy.filter((item) => item.releaseMin === nextRelease).map((item) => item.sceneId))];
      startMin = nextRelease;
      run = findFreeRun(occupancy, startMin, need, bayCount);
    }
    const chosenBays = run;

    const endMin = startMin + durationMin;
    const releaseMin = endMin + changeoverMin;
    for (const bay of chosenBays) {
      occupancy[bay - 1] = { bay, startMin, releaseMin, sceneId: sceneInput.id };
    }

    entries.push({
      sceneId: sceneInput.id,
      seq: sceneInput.seq,
      title: sceneInput.title,
      spec,
      bays: chosenBays,
      startMin,
      endMin,
      releaseMin,
      delayed: startMin > initialReadyAt,
      blockedBySceneIds,
      waitingForSceneIds,
    });
  }

  const finishMin = entries.reduce((max, entry) => Math.max(max, entry.releaseMin), earliestStartMin);
  return { entries, finishMin, earliestStartMin, changeoverMin, bayCount };
}
