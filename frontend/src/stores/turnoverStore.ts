/**
 * 影窗周转账状态管理（Zustand）
 *
 * 账本语义：
 * - 只有「已开排」的场次会写账（screenLedgers 表），写账即锁定，之后场次再改也不翻旧账。
 * - 未开排场次的排期不入库，永远按最新场次数据 + 当前换景设置现算，
 *   所以时长 / 顺序 / 影窗规格一改，未开排的周转天然作废重算。
 * - 每次只按场序确认「下一场」：落库前按 sceneId 查重，同一场绝不重复占台；
 *   写账失败可原样重试，接着最后确认的一场往下走。
 */
import { create } from 'zustand';
import {
  ROW_REVISION,
  listScenesByPlay,
  listLedgersByPlay,
  getLedgerByScene,
  putLedger,
  removeLatestLedger,
  removeLedgersByPlay,
  removeLedgersByScenes,
  type SceneRow,
  type ScreenLedgerRow,
} from '../utils/db';
import {
  DEFAULT_BASE_CLOCK_MIN,
  DEFAULT_CHANGEOVER_MIN,
  normalizeScreenSpec,
} from '../types/turnover';
import { buildTurnoverPlan, planNextConfirmation } from '../utils/turnoverScheduler';
import { nowIso, uuid } from '../utils/uuid';
import { STORAGE_KEYS, readLocal, writeLocal } from '../utils/localStore';

interface TurnoverStoreState {
  playId: string | null;
  scenes: SceneRow[];
  entries: ScreenLedgerRow[];
  changeoverMin: number;
  baseClockMin: number;
  loading: boolean;
  writing: boolean;
  error: string;
  /** 最近一次写账失败的信息（用于重试提示） */
  lastWriteError: string;

  loadTurnover: (playId: string) => Promise<void>;
  setChangeoverMin: (minutes: number) => void;
  setBaseClockMin: (minutes: number) => void;

  /** 按场序确认下一场开排并写账；返回落账行，无未开排场次时返回 null */
  confirmNext: () => Promise<{ sceneTitle: string; delayMin: number } | null>;
  /** 一场场连着写，直到全部开排或某场写账失败 */
  confirmAll: () => Promise<{ confirmed: number; failedSceneTitle: string | null }>;
  /** 回退最后确认的一场账 */
  rollbackLast: () => Promise<void>;
  /** 清空本剧目的周转账，全部回到未开排重算 */
  resetLedger: () => Promise<void>;
}

function readPositiveMin(key: (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS], fallback: number): number {
  const raw = Number(readLocal(key, ''));
  return Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : fallback;
}

export const useTurnoverStore = create<TurnoverStoreState>((set, get) => ({
  playId: null,
  scenes: [],
  entries: [],
  changeoverMin: readPositiveMin(STORAGE_KEYS.turnoverChangeoverMin, DEFAULT_CHANGEOVER_MIN),
  baseClockMin: readPositiveMin(STORAGE_KEYS.turnoverBaseClockMin, DEFAULT_BASE_CLOCK_MIN),
  loading: false,
  writing: false,
  error: '',
  lastWriteError: '',

  async loadTurnover(playId) {
    set({ loading: true, error: '' });
    try {
      const [scenes, entries] = await Promise.all([listScenesByPlay(playId), listLedgersByPlay(playId)]);
      // 场次可能在账本页之外被删：清掉对应的孤儿账本条
      const liveIds = new Set(scenes.map((scene) => scene.id));
      const orphanIds = entries.map((entry) => entry.sceneId).filter((sceneId) => !liveIds.has(sceneId));
      if (orphanIds.length > 0) await removeLedgersByScenes(orphanIds);
      set({
        playId,
        scenes,
        entries: orphanIds.length > 0 ? entries.filter((entry) => liveIds.has(entry.sceneId)) : entries,
        loading: false,
      });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : '影窗周转账读取失败' });
    }
  },

  setChangeoverMin(minutes) {
    const safe = Number.isFinite(minutes) ? Math.max(0, Math.round(minutes)) : DEFAULT_CHANGEOVER_MIN;
    set({ changeoverMin: safe });
    writeLocal(STORAGE_KEYS.turnoverChangeoverMin, String(safe));
  },

  setBaseClockMin(minutes) {
    const safe = Number.isFinite(minutes) ? Math.round(minutes) : DEFAULT_BASE_CLOCK_MIN;
    set({ baseClockMin: safe });
    writeLocal(STORAGE_KEYS.turnoverBaseClockMin, String(safe));
  },

  async confirmNext() {
    const state = get();
    const { playId, scenes, entries, changeoverMin } = state;
    if (!playId || state.writing) return null;

    const next = planNextConfirmation(scenes, entries, changeoverMin);
    if (!next) return null;
    const row = next;

    // 写账前再查一次库：同场不重复占台（上次写了一半 / 重复点击都挡住）
    const already = await getLedgerByScene(row.sceneId);
    if (already) {
      await get().loadTurnover(playId);
      return { sceneTitle: row.title, delayMin: already.delayMin };
    }

    set({ writing: true, lastWriteError: '' });
    try {
      const stamp = nowIso();
      const ledgerRow: ScreenLedgerRow = {
        id: uuid(),
        playId,
        sceneId: row.sceneId,
        orderIndex: row.orderIndex,
        screenSpec: normalizeScreenSpec(row.spec),
        slots: row.slots,
        durationMin: row.durationMin,
        changeoverMin: row.changeoverMin,
        startMin: row.startMin,
        endMin: row.endMin,
        setMin: row.setMin,
        delayMin: row.delayMin,
        blockedBySceneIds: [...row.blockedBySceneIds],
        confirmedAt: stamp,
        createdAt: stamp,
        updatedAt: stamp,
        revision: ROW_REVISION,
      };
      await putLedger(ledgerRow);
      await get().loadTurnover(playId);
      set({ writing: false });
      return { sceneTitle: row.title, delayMin: row.delayMin };
    } catch (error) {
      // 失败不落任何本地状态，重试时从最后确认的一场接着算
      set({
        writing: false,
        lastWriteError: error instanceof Error ? error.message : '写账失败，请重试',
      });
      throw error;
    }
  },

  async confirmAll() {
    let confirmed = 0;
    // 逐场写：每场都重新读取重算，中间失败就停在最后确认的一场
    for (;;) {
      const state = get();
      const planned = planNextConfirmation(state.scenes, state.entries, state.changeoverMin);
      if (!planned) return { confirmed, failedSceneTitle: null };
      try {
        const result = await get().confirmNext();
        if (result === null) return { confirmed, failedSceneTitle: null };
        confirmed += 1;
      } catch {
        return { confirmed, failedSceneTitle: planned.title };
      }
    }
  },

  async rollbackLast() {
    const { playId } = get();
    if (!playId) return;
    set({ writing: true, lastWriteError: '' });
    try {
      await removeLatestLedger(playId);
      await get().loadTurnover(playId);
    } catch (error) {
      set({ lastWriteError: error instanceof Error ? error.message : '回退失败，请重试' });
    } finally {
      set({ writing: false });
    }
  },

  async resetLedger() {
    const { playId } = get();
    if (!playId) return;
    set({ writing: true, lastWriteError: '' });
    try {
      await removeLedgersByPlay(playId);
      await get().loadTurnover(playId);
    } catch (error) {
      set({ lastWriteError: error instanceof Error ? error.message : '清空账本失败，请重试' });
    } finally {
      set({ writing: false });
    }
  },
}));

/** 组件侧派生：当前场次 + 账本条 → 周转计划 */
export function selectTurnoverPlan(state: TurnoverStoreState) {
  return buildTurnoverPlan(state.scenes, state.entries, state.changeoverMin);
}
