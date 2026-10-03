/**
 * 影窗周转排程算法（纯函数，可单测）
 *
 * 规则：
 * - 固定 SCREEN_CAPACITY 台标准影窗；一场占 slots 个台口（双联 2，其余 1）。
 * - 按开排顺序（场序）逐场安排；一场占台区间为 [start, end + changeover)，
 *   即散场后必须留够换景时间才把台口放给后面的场次。
 * - 某时刻在占台口总数不得超过容量；不够就把该场顺延到最近的可行时刻（排队顺延），
 *   并登记一路上是被哪几场占着。
 * - 已开排（已写账）的场次是固定约束，永不重排；未开排场次永远按最新数据现算，
 *   因此「时长 / 顺序 / 规格改动后未开排的周转发作」天然成立——只需在本函数里重算。
 */
import {
  SCREEN_CAPACITY,
  normalizeScreenSpec,
  screenSlotsOf,
  type ScreenLedgerEntry,
} from '../types/turnover';

/** 排程输入里只依赖场次的这几个字段 */
export interface ScheduleSceneInput {
  id: string;
  seq: number;
  title: string;
  durationMin: number;
  /** 原始影窗规格，可能缺失（旧场次按标准影窗兜底） */
  needsShadowScreen?: unknown;
}

/** 一条排期结果：已开排走账上的快照，未开排为预估 */
export interface ScheduleRow {
  sceneId: string;
  orderIndex: number;
  title: string;
  spec: ReturnType<typeof normalizeScreenSpec>;
  slots: number;
  durationMin: number;
  changeoverMin: number;
  startMin: number;
  endMin: number;
  setMin: number;
  delayMin: number;
  blockedBySceneIds: string[];
  /** 是否已开排（已写账，锁定） */
  confirmed: boolean;
  /** 已开排但场次后来改了时长 / 规格，账上与现状对不上 */
  drift: boolean;
  /** 关联的账本条 id（仅已开排有） */
  entryId?: string;
  confirmedAt?: string;
}

export interface TurnoverPlan {
  /** 按当前场序排好的全部场次 */
  rows: ScheduleRow[];
  /** 已开排条数 */
  confirmedCount: number;
  /** 未开排条数 */
  pendingCount: number;
  /** 预估顺延场次数（不含已开排） */
  delayedCount: number;
  /** 整场散台（最后一场放台）的相对分钟 */
  finishMin: number;
}

/** 内部使用的占台区间 */
interface Interval {
  sceneId: string;
  slots: number;
  /** 含起点、不含终点 */
  from: number;
  to: number;
}

function safeDuration(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.max(1, Math.round(n)) : 1;
}

function safeChangeover(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

/** t 时刻正在占台（含 t、不含 setMin）的区间 */
function activeAt(intervals: Interval[], t: number): Interval[] {
  return intervals.filter((item) => item.from <= t && t < item.to);
}

interface FeasibleResult {
  startMin: number;
  delayMin: number;
  blockedBySceneIds: string[];
}

/**
 * 在固定区间集合里，为需要 slots 个台口的场次找最早可行开台时刻。
 * 候选时刻只有「不早于 earliest」的现有区间放台点：区间只在这些点变短，
 * 所以最早可行解必落在其中之一（或 earliest 本身）。
 */
function earliestFeasible(
  fixed: Interval[],
  slots: number,
  earliest: number,
): FeasibleResult {
  // 单场自身需求超过总容量属于不可能，但容量 3、最大 2，兜底防御一下
  if (slots > SCREEN_CAPACITY) {
    throw new Error(`单场需占 ${slots} 个台口，超过后台容量 ${SCREEN_CAPACITY}`);
  }

  const candidates = [earliest];
  fixed.forEach((item) => {
    if (item.to > earliest) candidates.push(item.to);
  });
  const uniqueSorted = [...new Set(candidates)].sort((a, b) => a - b);
  const blockers = new Set<string>();

  for (const candidate of uniqueSorted) {
    if (candidate < earliest) continue;
    const holders = activeAt(fixed, candidate);
    if (holders.reduce((acc, item) => acc + item.slots, 0) + slots <= SCREEN_CAPACITY) {
      // 可行：一路上每个开不了的时刻，谁正占着台就写明被哪场占着
      return {
        startMin: candidate,
        delayMin: candidate - earliest,
        blockedBySceneIds: [...blockers],
      };
    }
    holders.forEach((item) => blockers.add(item.sceneId));
  }

  // 理论不可达：最大放台点之后固定占用为 0
  const fallback = uniqueSorted[uniqueSorted.length - 1] ?? earliest;
  return { startMin: fallback, delayMin: fallback - earliest, blockedBySceneIds: [...blockers] };
}

/**
 * 计算整出戏的影窗周转账面。
 *
 * @param scenes    按当前场序排好的场次（顺序即开排顺序）
 * @param entries   已写账（已开排）的账本条
 * @param changeoverMin 未开排场次使用的换景留白（分钟）
 */
export function buildTurnoverPlan(
  scenes: ScheduleSceneInput[],
  entries: ScreenLedgerEntry[],
  changeoverMin: number,
): TurnoverPlan {
  const changeover = safeChangeover(changeoverMin);
  const entryByScene = new Map(entries.map((entry) => [entry.sceneId, entry]));

  // 已开排场次：账上快照即固定占台区间，永不重排
  const fixedIntervals: Interval[] = [];
  const confirmedByScene = new Map<string, ScheduleRow>();
  entries.forEach((entry) => {
    const duration = safeDuration(entry.durationMin);
    const co = safeChangeover(entry.changeoverMin);
    fixedIntervals.push({
      sceneId: entry.sceneId,
      slots: entry.slots,
      from: entry.startMin,
      to: entry.startMin + duration + co,
    });
    confirmedByScene.set(entry.sceneId, {
      sceneId: entry.sceneId,
      orderIndex: entry.orderIndex,
      title: scenes.find((scene) => scene.id === entry.sceneId)?.title ?? `已删场序 ${entry.orderIndex}`,
      spec: normalizeScreenSpec(entry.screenSpec),
      slots: entry.slots,
      durationMin: duration,
      changeoverMin: co,
      startMin: entry.startMin,
      endMin: entry.startMin + duration,
      setMin: entry.startMin + duration + co,
      delayMin: entry.delayMin,
      blockedBySceneIds: [...entry.blockedBySceneIds],
      confirmed: true,
      drift: false,
      entryId: entry.id,
      confirmedAt: entry.confirmedAt,
    });
  });

  const rows: ScheduleRow[] = [];
  let prefixStart = 0;

  scenes.forEach((scene, index) => {
    const orderIndex = index + 1;
    const existing = entryByScene.get(scene.id);
    if (existing) {
      const duration = safeDuration(existing.durationMin);
      const currentSpec = normalizeScreenSpec(scene.needsShadowScreen);
      const row = confirmedByScene.get(scene.id);
      if (row) {
        row.orderIndex = orderIndex;
        row.title = scene.title;
        row.drift =
          safeDuration(scene.durationMin) !== duration ||
          normalizeScreenSpec(existing.screenSpec) !== currentSpec;
        rows.push(row);
        prefixStart = Math.max(prefixStart, existing.startMin);
      }
      return;
    }

    const duration = safeDuration(scene.durationMin);
    const spec = normalizeScreenSpec(scene.needsShadowScreen);
    const slots = screenSlotsOf(spec);
    // 顺序即开排顺序：不早于前面任何一场的开台时刻（含已开排锁定值）
    const earliest = prefixStart;
    const result = earliestFeasible(fixedIntervals, slots, earliest);

    const row: ScheduleRow = {
      sceneId: scene.id,
      orderIndex,
      title: scene.title,
      spec,
      slots,
      durationMin: duration,
      changeoverMin: changeover,
      startMin: result.startMin,
      endMin: result.startMin + duration,
      setMin: result.startMin + duration + changeover,
      delayMin: result.delayMin,
      blockedBySceneIds: result.blockedBySceneIds,
      confirmed: false,
      drift: false,
    };
    rows.push(row);
    // 未开排排期同样作为后续未开排场次的占台约束
    fixedIntervals.push({
      sceneId: scene.id,
      slots,
      from: row.startMin,
      to: row.setMin,
    });
    prefixStart = row.startMin;
  });

  // 已删场次的孤儿账本条不在 rows 里，交给上层清理
  const pending = rows.filter((row) => !row.confirmed);
  const finishMin = rows.reduce((acc, row) => Math.max(acc, row.setMin), 0);

  return {
    rows,
    confirmedCount: rows.length - pending.length,
    pendingCount: pending.length,
    delayedCount: pending.filter((row) => row.delayMin > 0).length,
    finishMin,
  };
}

/**
 * 给「下一场开排」算落账数据：按当前场序取第一条未开排场次，
 * 以全部已开排账本条为固定约束重算，返回该场写账所需字段。
 * 与 buildTurnoverPlan 同算法，单独返回单场结果便于 store 落库。
 */
export function planNextConfirmation(
  scenes: ScheduleSceneInput[],
  entries: ScreenLedgerEntry[],
  changeoverMin: number,
): ScheduleRow | null {
  const plan = buildTurnoverPlan(scenes, entries, changeoverMin);
  return plan.rows.find((row) => !row.confirmed) ?? null;
}
