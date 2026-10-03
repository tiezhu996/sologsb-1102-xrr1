/**
 * 影窗周转账状态管理（Zustand）。
 * 每个剧目独立一本账：读出场次/已确认账行/周转设置 → 重算未开排周转；
 * 写账失败可重试，接着最后确认的一场往下走。
 */
import { create } from 'zustand';
import {
  listScenesByPlay,
  getRotationSettings,
  putRotationSettings,
  ROW_REVISION,
  type SceneRow,
  type RotationSettingsRow,
} from '../utils/db';
import { rotationSink } from '../utils/rotationSink';
import { nowIso } from '../utils/uuid';
import {
  buildRotationPlan,
  commitRotationPlan,
  scenesFingerprint,
  DEFAULT_ROTATION_SETTINGS,
  type CommitResult,
  type RotationPlanResult,
  type RotationSettings,
} from '../utils/rotationLedger';

interface RotationStoreState {
  playId: string | null;
  scenes: SceneRow[];
  settings: RotationSettings;
  plan: RotationPlanResult | null;
  /** 已确认（已开排）场次数 */
  confirmedCount: number;
  /** 场次输入是否相对上次落账发生过改动（未开排周转已重算） */
  stale: boolean;
  loading: boolean;
  committing: boolean;
  error: string;
  /** 最近一次写账结果（含失败信息，用于界面提示重试） */
  lastCommit: CommitResult | null;
  load: (playId: string) => Promise<void>;
  saveSettings: (patch: Partial<RotationSettings>) => Promise<void>;
  /** 开排确认到第 seq 场（含） */
  confirmUpTo: (seq: number) => Promise<CommitResult>;
  /** 写账失败后重试：接着最后确认的一场往下写到同一目标场序 */
  retryCommit: () => Promise<CommitResult>;
}

/** 待确认目标场序（失败后重试沿用），按剧目隔离 */
const pendingTargetSeqByPlay = new Map<string, number>();

function pendingTargetOf(playId: string): number | null {
  return pendingTargetSeqByPlay.get(playId) ?? null;
}

export const useRotationStore = create<RotationStoreState>((set, get) => ({
  playId: null,
  scenes: [],
  settings: { ...DEFAULT_ROTATION_SETTINGS },
  plan: null,
  confirmedCount: 0,
  stale: false,
  loading: false,
  committing: false,
  error: '',
  lastCommit: null,

  async load(playId) {
    set({ loading: true, error: '' });
    try {
      const [scenes, settingsRow] = await Promise.all([
        listScenesByPlay(playId),
        getRotationSettings(playId),
      ]);
      const settings: RotationSettings = settingsRow?.settings ?? { ...DEFAULT_ROTATION_SETTINGS };
      const confirmedEntries = await rotationSink.listByPlay(playId);
      const plan = buildRotationPlan(playId, scenes, settings, confirmedEntries);
      // 用保存的指纹判断未开排部分是否已被改动（仅作界面高亮）；从未算过（null/缺行）不算过期
      const pendingFingerprint = settingsRow?.pendingFingerprint ?? null;
      const stale =
        pendingFingerprint !== null &&
        scenesFingerprint(
          scenes.filter((scene) => !confirmedEntries.some((entry) => entry.sceneId === scene.id)),
        ) !== pendingFingerprint;
      set({
        playId,
        scenes,
        settings,
        plan,
        confirmedCount: confirmedEntries.length,
        stale,
        loading: false,
      });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : '影窗周转读取失败' });
    }
  },

  async saveSettings(patch) {
    const { playId, scenes, settings, confirmedCount } = get();
    if (!playId) return;
    const nextSettings: RotationSettings = { ...settings, ...patch };
    const confirmedEntries = await rotationSink.listByPlay(playId);
    const plan = buildRotationPlan(playId, scenes, nextSettings, confirmedEntries);
    set({ settings: nextSettings, plan, confirmedCount });
    const row: RotationSettingsRow = {
      playId,
      settings: nextSettings,
      pendingFingerprint: fingerprintPending(scenes, confirmedEntries),
      updatedAt: nowIso(),
      revision: ROW_REVISION,
    };
    await putRotationSettings(row);
  },

  async confirmUpTo(seq) {
    const { playId, plan, settings } = get();
    if (!playId || !plan) {
      return { ok: false, written: 0, skipped: 0, lastConfirmedSeq: 0, error: '周转未加载' };
    }
    pendingTargetSeqByPlay.set(playId, seq);
    set({ committing: true, error: '' });
    const result = await commitRotationPlan(plan, rotationSink, { playId, settings, upToSceneSeq: seq });
    await get().load(playId);
    await persistFingerprint(playId);
    set({ committing: false, lastCommit: result, error: result.ok ? '' : result.error ?? '写账失败' });
    if (result.ok) pendingTargetSeqByPlay.delete(playId);
    return result;
  },

  async retryCommit() {
    const { playId } = get();
    const target = playId ? pendingTargetOf(playId) : null;
    if (!playId || target === null) {
      return get().lastCommit ?? { ok: false, written: 0, skipped: 0, lastConfirmedSeq: 0, error: '没有待重试的写账' };
    }
    // 重试前先按账上已确认行重建计划（接着最后确认的一场往下走）
    await get().load(playId);
    return get().confirmUpTo(target);
  },
}));

function fingerprintPending(scenes: SceneRow[], confirmed: { sceneId: string }[]): string {
  const ids = new Set(confirmed.map((entry) => entry.sceneId));
  return scenesFingerprint(scenes.filter((scene) => !ids.has(scene.id)));
}

async function persistFingerprint(playId: string): Promise<void> {
  const state = useRotationStore.getState();
  const confirmed = await rotationSink.listByPlay(playId);
  const row: RotationSettingsRow = {
    playId,
    settings: state.settings,
    pendingFingerprint: fingerprintPending(state.scenes, confirmed),
    updatedAt: nowIso(),
    revision: ROW_REVISION,
  };
  await putRotationSettings(row);
}
