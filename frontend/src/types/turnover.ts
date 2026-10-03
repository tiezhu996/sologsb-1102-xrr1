/**
 * 影窗周转账（ScreenTurnover）数据模型
 * 后台固定三台标准影窗，按开排顺序逐场占台写账；双联影窗占两台，
 * 散场后留够换景时间才放给下一场，容量不够则排队顺延并登记占台场次。
 */
import type { ShadowScreenSpec } from './scene';

/** 后台标准影窗总台口容量（固定三台） */
export const SCREEN_CAPACITY = 3;

/** 默认换景时间（分钟）：散场后留这么久才放影窗给下一场 */
export const DEFAULT_CHANGEOVER_MIN = 10;

/** 默认开排基准时刻（分钟，19:30），仅用于把相对分钟翻译成台口时钟 */
export const DEFAULT_BASE_CLOCK_MIN = 19 * 60 + 30;

/** 各规格影窗占几个台口：双联算两台，其余各占一台 */
export const SCREEN_SLOT_COST: Record<ShadowScreenSpec, number> = {
  small: 1,
  standard: 1,
  large: 1,
  twin: 2,
};

/**
 * 旧场次可能没登记影窗规格（v1 历史数据或字段缺失），一律按标准影窗算。
 * 收到不在四档里的值也兜底成 standard。
 */
export function normalizeScreenSpec(raw: unknown): ShadowScreenSpec {
  if (raw === 'small' || raw === 'standard' || raw === 'large' || raw === 'twin') {
    return raw;
  }
  return 'standard';
}

/** 规格 → 占台口数（缺规格按标准影窗一台） */
export function screenSlotsOf(spec: unknown): number {
  return SCREEN_SLOT_COST[normalizeScreenSpec(spec)];
}

/**
 * 一条已落账的影窗周转记录：只有「已开排」的场次才写账。
 * 写账时把时长 / 规格 / 换景时间一并快照，之后场次再改也不翻旧账，
 * 未开排场次的排期永远按最新数据现算（作废重算）。
 */
export interface ScreenLedgerEntry {
  /** 主键，uuid */
  id: string;
  /** 所属剧目 id */
  playId: string;
  /** 占台场次 id（同场不重复占台的唯一约束） */
  sceneId: string;
  /** 开排时的场序（从 1 开始，仅作展示，排期以 sceneId 关联） */
  orderIndex: number;
  /** 开排时登记的影窗规格 */
  screenSpec: ShadowScreenSpec;
  /** 占台口数（双联 2，其余 1） */
  slots: number;
  /** 开排时的场次时长（分钟） */
  durationMin: number;
  /** 本场散场后的换景留白（分钟） */
  changeoverMin: number;
  /** 开台分钟（相对开排基准 0 点） */
  startMin: number;
  /** 散场分钟 = startMin + durationMin */
  endMin: number;
  /** 放台分钟 = endMin + changeoverMin，下一场最早此时可占 */
  setMin: number;
  /** 相对最早可开时刻顺延的分钟数（0 表示准点开台） */
  delayMin: number;
  /** 排队顺延时登记的占台场次 id（写明被哪场占着） */
  blockedBySceneIds: string[];
  /** 确认写账（开排）时间，ISO 字符串；也是「最后确认的一场」的排序依据 */
  confirmedAt: string;
  createdAt: string;
  updatedAt: string;
}
