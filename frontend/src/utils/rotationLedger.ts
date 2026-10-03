/**
 * 影窗周转「账」：在纯排期算法（screenRotation）之上加三件事——
 * 1. 输入指纹：场次时长 / 顺序 / 规格任一改动，未开排（未确认）的周转作废重算；
 *    已写账（已开排）的场次锁定，不重排、不重复占台。
 * 2. 断点写账：按场序逐场落库，可指定确认到第几场；写失败时保留已确认部分，
 *    重试时接着最后确认的一场往下写，同一场绝不重复占台。
 * 3. 旧场次兜底：库里没有影窗规格字段的旧场次，按一台标准影窗算。
 */
import {
  baysOf,
  DEFAULT_CHANGEOVER_MIN,
  EARLIEST_START_MIN,
  STANDARD_BAY_COUNT,
  type RotationSceneInput,
} from './screenRotation';
import type { SceneRow } from './db';
import type { ShadowScreenSpec } from '../types/scene';

/** 周转设置（开排时刻、换景时间），随账记录，保证旧账可还原 */
export interface RotationSettings {
  earliestStartMin: number;
  changeoverMin: number;
}

export const DEFAULT_ROTATION_SETTINGS: RotationSettings = {
  earliestStartMin: EARLIEST_START_MIN,
  changeoverMin: DEFAULT_CHANGEOVER_MIN,
};

/** 落库的账行：一场一行，写进去即表示该场已开排、占台锁定 */
export interface LedgerEntry {
  playId: string;
  sceneId: string;
  seq: number;
  title: string;
  spec: ShadowScreenSpec;
  bays: number[];
  startMin: number;
  endMin: number;
  releaseMin: number;
  delayed: boolean;
  blockedBySceneIds: string[];
  waitingForSceneIds: string[];
  /** 写账时该场的输入指纹（已开排行即使指纹过期也不重排） */
  inputFingerprint: string;
  /** 写账时使用的周转设置 */
  settings: RotationSettings;
  confirmedAt: string;
}

/** 计划行：带确认状态与指纹，未写账前可以反复重算 */
export interface PlannedEntry {
  sceneId: string;
  seq: number;
  title: string;
  spec: ShadowScreenSpec;
  bays: number[];
  startMin: number;
  endMin: number;
  releaseMin: number;
  delayed: boolean;
  blockedBySceneIds: string[];
  waitingForSceneIds: string[];
  status: 'confirmed' | 'planned';
  inputFingerprint: string;
}

/** 一轮周转结果：前若干行为已确认（固定占台），其后为未开排重算结果 */
export interface RotationPlanResult {
  playId: string;
  settings: RotationSettings;
  entries: PlannedEntry[];
  confirmedSceneIds: string[];
  finishMin: number;
}

export interface CommitResult {
  ok: boolean;
  /** 本次新写入的场次数（跳过的已确认场次不计） */
  written: number;
  /** 本次跳过的已确认场次数 */
  skipped: number;
  /** 目前账上已确认到的场序 */
  lastConfirmedSeq: number;
  /** 写失败的场次（ok=false 时有值） */
  failedSceneId?: string;
  error?: string;
}

export interface CommitOptions {
  playId: string;
  settings: RotationSettings;
  /** 确认（开排）到第几场，按场序 */
  upToSceneSeq: number;
  /** 注入当前时间，便于测试 */
  now?: () => string;
}

/** 账台读写抽象：生产用 Dexie 实现，测试用内存实现 */
export interface RotationSink {
  appendEntry(entry: LedgerEntry): Promise<void>;
  listByPlay(playId: string): Promise<LedgerEntry[]>;
}

interface BayInterval {
  startMin: number;
  releaseMin: number;
  sceneId: string;
}

/** 把库里的场次行（可能没有规格字段）收敛成算法输入 */
export function toRotationInput(row: SceneRow): RotationSceneInput {
  return {
    id: row.id,
    seq: row.seq,
    title: row.title,
    durationMin: row.durationMin,
    // 旧场次没登记规格：传 undefined，算法侧按一台标准影窗兜底
    spec: typeof (row as Partial<SceneRow>).needsShadowScreen === 'string'
      ? row.needsShadowScreen
      : undefined,
  };
}

/** 单场周转指纹：只含影响占台的要素（顺序 / 时长 / 规格），标题改动不导致作废 */
export function rotationFingerprint(input: RotationSceneInput): string {
  const specKey = input.spec === 'twin' ? 'twin' : '1';
  return `${input.seq}|${Math.max(0, Math.round(input.durationMin))}|${specKey}|${baysOf(input.spec)}`;
}

/** 单组场次（按场序）的指纹：任何场次增删 / 顺序 / 时长 / 规格变化都会变 */
export function scenesFingerprint(scenes: Array<Pick<SceneRow, 'id' | 'seq' | 'durationMin' | 'needsShadowScreen'>>): string {
  return scenes
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((scene) => {
      const input = toRotationInput(scene as SceneRow);
      return `${scene.id}:${rotationFingerprint(input)}`;
    })
    .join(';;');
}

/**
 * 判断一份「未开排周转」是否已过期：把当前场次指纹与上次计算时保存的指纹对比。
 * 已开排（已确认）场次单独锁定，不参与过期判断。
 */
export function isPlanStale(
  scenes: SceneRow[],
  confirmed: LedgerEntry[],
  savedFingerprint: string | null,
): boolean {
  if (savedFingerprint === null) return true;
  const confirmedIds = new Set(confirmed.map((entry) => entry.sceneId));
  const pending = scenes
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .filter((scene) => !confirmedIds.has(scene.id));
  return scenesFingerprint(pending) !== savedFingerprint;
}

function normalizeSpec(spec: RotationSceneInput['spec']): ShadowScreenSpec {
  if (spec === 'small' || spec === 'standard' || spec === 'large' || spec === 'twin') return spec;
  return 'standard';
}

/**
 * 计算周转：已确认场次作为固定占台锁定，其后未开排场次按当前输入重算。
 * 纯函数，不写库。
 */
export function buildRotationPlan(
  playId: string,
  scenes: SceneRow[],
  settings: RotationSettings,
  ledgerEntries: LedgerEntry[],
): RotationPlanResult {
  const orderedScenes = scenes.slice().sort((a, b) => a.seq - b.seq);
  const ledgerById = new Map(
    ledgerEntries.filter((entry) => entry.playId === playId).map((entry) => [entry.sceneId, entry]),
  );

  // 每窗位一条占用链，先放已确认（不可移动）占用
  const perBay: BayInterval[][] = Array.from({ length: STANDARD_BAY_COUNT }, () => []);
  const fixedEntries: PlannedEntry[] = [];
  const fixedIds = new Set<string>();

  for (const sceneRow of orderedScenes) {
    const ledger = ledgerById.get(sceneRow.id);
    if (!ledger) continue;
    fixedIds.add(sceneRow.id);
    for (const bay of ledger.bays) {
      perBay[bay - 1].push({
        startMin: ledger.startMin,
        releaseMin: ledger.releaseMin,
        sceneId: sceneRow.id,
      });
    }
    fixedEntries.push({
      sceneId: sceneRow.id,
      seq: sceneRow.seq,
      title: sceneRow.title,
      spec: ledger.spec,
      bays: [...ledger.bays],
      startMin: ledger.startMin,
      endMin: ledger.endMin,
      releaseMin: ledger.releaseMin,
      delayed: ledger.delayed,
      blockedBySceneIds: [...ledger.blockedBySceneIds],
      waitingForSceneIds: [...ledger.waitingForSceneIds],
      status: 'confirmed',
      inputFingerprint: ledger.inputFingerprint,
    });
  }
  for (const list of perBay) list.sort((a, b) => a.startMin - b.startMin);
  fixedEntries.sort((a, b) => a.seq - b.seq);

  // 排队起点：不早于已确认最后一场的开排时刻
  const lastFixedStart = fixedEntries.reduce(
    (max, entry) => Math.max(max, entry.startMin),
    settings.earliestStartMin,
  );

  const busySceneIdsAt = (t: number): string[] => {
    const ids: string[] = [];
    perBay.forEach((list) => {
      for (const iv of list) {
        if (iv.startMin <= t && t < iv.releaseMin) ids.push(iv.sceneId);
      }
    });
    return [...new Set(ids)];
  };

  const findFreeRun = (t: number, need: number): number[] | null => {
    let run: number[] = [];
    for (let bay = 1; bay <= STANDARD_BAY_COUNT; bay += 1) {
      const busy = perBay[bay - 1].some((iv) => iv.startMin <= t && t < iv.releaseMin);
      if (busy) run = [];
      else {
        run.push(bay);
        if (run.length === need) return run;
      }
    }
    return null;
  };

  const plannedEntries: PlannedEntry[] = [];
  let prevStart = lastFixedStart;

  for (const sceneRow of orderedScenes.filter((s) => !fixedIds.has(s.id))) {
    const input = toRotationInput(sceneRow);
    const need = baysOf(input.spec);
    if (need > STANDARD_BAY_COUNT) {
      throw new Error(`影窗规格所需窗位超过台口容量（共 ${STANDARD_BAY_COUNT} 台标准影窗），无法占台`);
    }

    // 严格排队：不早于上一场（含已确认的最后一场）开排时刻
    const initialReadyAt = Math.max(settings.earliestStartMin, prevStart);
    const blockedBySceneIds = busySceneIdsAt(initialReadyAt);

    let startMin = initialReadyAt;
    let waitingForSceneIds: string[] = [];
    let run = findFreeRun(startMin, need);
    while (!run) {
      const busy = perBay.flatMap((list, index) =>
        list
          .filter((iv) => iv.startMin <= startMin && startMin < iv.releaseMin)
          .map((iv) => ({ bay: index + 1, ...iv })),
      );
      const nextRelease = Math.min(...busy.map((iv) => iv.releaseMin));
      waitingForSceneIds = [...new Set(busy.filter((iv) => iv.releaseMin === nextRelease).map((iv) => iv.sceneId))];
      startMin = nextRelease;
      run = findFreeRun(startMin, need);
    }

    const endMin = startMin + Math.max(0, sceneRow.durationMin);
    const releaseMin = endMin + settings.changeoverMin;
    for (const bay of run) {
      perBay[bay - 1].push({ startMin, releaseMin, sceneId: sceneRow.id });
      perBay[bay - 1].sort((a, b) => a.startMin - b.startMin);
    }

    plannedEntries.push({
      sceneId: sceneRow.id,
      seq: sceneRow.seq,
      title: sceneRow.title,
      spec: normalizeSpec(input.spec),
      bays: run,
      startMin,
      endMin,
      releaseMin,
      delayed: startMin > initialReadyAt,
      blockedBySceneIds,
      waitingForSceneIds,
      status: 'planned',
      inputFingerprint: rotationFingerprint(input),
    });
    prevStart = startMin;
  }

  const entries = [...fixedEntries, ...plannedEntries].sort((a, b) => a.seq - b.seq);
  const finishMin = entries.reduce(
    (max, entry) => Math.max(max, entry.releaseMin),
    settings.earliestStartMin,
  );

  return {
    playId,
    settings,
    entries,
    confirmedSceneIds: fixedEntries.map((entry) => entry.sceneId),
    finishMin,
  };
}

/**
 * 按场序把计划写到账台（开排确认）。
 * - 只写 upToSceneSeq 之前（含）且账上还没有的行；已确认行跳过，保证同场不重复占台。
 * - 中途写失败立即停：已写入的保留，返回 lastConfirmedSeq；重试时从下一场继续。
 */
export async function commitRotationPlan(
  plan: RotationPlanResult,
  sink: RotationSink,
  options: CommitOptions,
): Promise<CommitResult> {
  const stored = await sink.listByPlay(options.playId);
  const existingIds = new Set(stored.map((entry) => entry.sceneId));

  const targets = plan.entries
    .filter((entry) => entry.seq <= options.upToSceneSeq)
    .sort((a, b) => a.seq - b.seq);

  let written = 0;
  let skipped = 0;
  let lastConfirmedSeq = stored.reduce((max, entry) => Math.max(max, entry.seq), 0);
  const stamp = options.now ? options.now() : new Date().toISOString();

  for (const entry of targets) {
    if (existingIds.has(entry.sceneId)) {
      skipped += 1;
      lastConfirmedSeq = Math.max(lastConfirmedSeq, entry.seq);
      continue;
    }
    const ledgerEntry: LedgerEntry = {
      playId: options.playId,
      sceneId: entry.sceneId,
      seq: entry.seq,
      title: entry.title,
      spec: entry.spec,
      bays: entry.bays,
      startMin: entry.startMin,
      endMin: entry.endMin,
      releaseMin: entry.releaseMin,
      delayed: entry.delayed,
      blockedBySceneIds: entry.blockedBySceneIds,
      waitingForSceneIds: entry.waitingForSceneIds,
      inputFingerprint: entry.inputFingerprint,
      settings: options.settings,
      confirmedAt: stamp,
    };
    try {
      await sink.appendEntry(ledgerEntry);
    } catch (error) {
      return {
        ok: false,
        written,
        skipped,
        lastConfirmedSeq,
        failedSceneId: entry.sceneId,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    existingIds.add(entry.sceneId);
    written += 1;
    lastConfirmedSeq = Math.max(lastConfirmedSeq, entry.seq);
  }

  return { ok: true, written, skipped, lastConfirmedSeq };
}

/** 读账 + 按当前场次重算未开排部分：界面/重试都从这里恢复 */
export async function loadRotationState(
  playId: string,
  scenes: SceneRow[],
  settings: RotationSettings,
  sink: RotationSink,
): Promise<{ confirmedEntries: LedgerEntry[]; plan: RotationPlanResult }> {
  const confirmedEntries = (await sink.listByPlay(playId)).sort((a, b) => a.seq - b.seq);
  const plan = buildRotationPlan(playId, scenes, settings, confirmedEntries);
  return { confirmedEntries, plan };
}
