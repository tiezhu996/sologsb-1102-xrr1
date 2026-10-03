/**
 * 影窗周转账的 Dexie 适配：把 rotationLedger 的 RotationSink 接到 IndexedDB。
 */
import {
  listRotationEntriesByPlay,
  putRotationEntry,
  type ScreenRotationRow,
} from './db';
import type { LedgerEntry, RotationSink } from './rotationLedger';

export class DexieRotationSink implements RotationSink {
  async appendEntry(entry: LedgerEntry): Promise<void> {
    // 一场一行，主键即 sceneId：重复 put 同一场会覆盖而不是新增第二行，
    // 从存储层再兜一道「同一场不重复占台」。
    await putRotationEntry({ ...(entry as ScreenRotationRow) });
  }

  async listByPlay(playId: string): Promise<LedgerEntry[]> {
    return listRotationEntriesByPlay(playId);
  }
}

/** 全站复用一个 sink 实例（无状态，只是 Dexie 表的薄封装） */
export const rotationSink = new DexieRotationSink();
