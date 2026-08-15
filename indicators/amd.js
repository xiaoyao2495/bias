/**
 * AMD（Accumulation / Manipulation / Distribution）阶段判定。
 *
 * ICT 2022 Market Maker Model：机构在区间内积累仓位 → 扫流动性操纵价格（诱多/诱空）
 * → 真实订单进场推动（Displacement）。纪律：仅 Distribution 阶段执行交易。
 *
 * 本模块只做**阶段标注**（审计/展示），不参与 Bias 与 Decision（Bias 仍由 Structure 决定）。
 * 判定依据（按"最近发生的证据"主导，证据时间最新者胜出）：
 *   1. 最近窗口内有已确认 5m 位移        → DISTRIBUTION（方向 = 位移方向）
 *   2. 否则最近窗口内有扫损事件（收回）   → MANIPULATION（方向 = 诱多/诱空后的反转预期）
 *   3. 否则做"有证据的积累"判定（不再无证据兜底）：
 *        横盘（4h 效率比 ER < 0.25，折返无净位移）
 *        + 现价在 dealingRange 区间内
 *        + 窗口内无推进证据（无 5m MSS/BOS）
 *        → ACCUMULATION（区间震荡，机构吸筹）
 *   4. 不满足积累条件（趋势推进中/无区间/数据不足）→ UNSET（未定，不误标积累）
 *
 * @param {Object} args
 * @param {Object|null} args.displacement  最近位移 { time, direction: UP|DOWN, ratio } | null
 * @param {Object|null} args.sweep         最近扫损 { time, side: BSL|SSL } | null
 * @param {Object|null} args.structure     结构 { direction: BULLISH|BEARISH|NEUTRAL } | null
 * @param {Object|null} args.range         当前推动区间 { high, low, rangeType } | null（dealingRange）
 * @param {Array}       [args.mssEvents]   5m 层最近结构事件 [{ time, type: "MSS"|"BOS" }]
 * @param {Array}       [args.m5]          5m K 线（已收盘，算效率比 ER）
 * @param {number|null} [args.price]       现价（判断是否在区间内）
 * @param {number} [args.windowMs]         位移/扫损证据有效窗口（默认 24h）
 * @param {number} [args.now]              当前时间戳
 * @returns {{ stage: "ACCUMULATION"|"MANIPULATION"|"DISTRIBUTION"|"UNSET", direction: string, reason: string, evidenceTime: number|null }}
 */
import { marketNow } from "../utils/marketClock.js";

export function computeAmdStage({ displacement, sweep, structure, range, mssEvents, m5, price, windowMs = AMD_WINDOW_MS, now = marketNow() }) {
  const candidates = [];

  if (displacement && displacement.time != null && displacement.time >= now - windowMs) {
    candidates.push({
      time: displacement.time,
      stage: "DISTRIBUTION",
      direction: displacement.direction === "UP" ? "BULLISH" : "BEARISH",
      reason: `5m位移 ${displacement.ratio.toFixed(1)}× 推动`,
    });
  }

  if (sweep && sweep.time != null && sweep.time >= now - windowMs) {
    // 操纵方向 = 诱多/诱空后的反转预期：扫上方流动性（诱多）→ 看跌；扫下方（诱空）→ 看涨
    candidates.push({
      time: sweep.time,
      stage: "MANIPULATION",
      direction: sweep.side === "BSL" ? "BEARISH" : "BULLISH",
      reason: `扫${sweep.side === "BSL" ? "上方" : "下方"}流动性（收回）`,
    });
  }

  if (candidates.length) {
    candidates.sort((a, b) => b.time - a.time);
    return { stage: candidates[0].stage, direction: candidates[0].direction, reason: candidates[0].reason, evidenceTime: candidates[0].time };
  }

  // 无操纵/分发证据 → 有证据的积累判定（横盘 + 区间内 + 无推进），不满足则未定
  const acc = accumulationEvidence({ range, mssEvents, m5, price, now });
  if (acc) {
    const dir = structure && (structure.direction === "BULLISH" || structure.direction === "BEARISH") ? structure.direction : "NEUTRAL";
    return { stage: "ACCUMULATION", direction: dir, reason: acc.reason, evidenceTime: null };
  }
  return { stage: "UNSET", direction: "NEUTRAL", reason: "无积累证据（趋势推进或数据不足）", evidenceTime: null };
}

/** 有证据的积累判定：横盘（效率比 ER < 0.25）+ 现价在区间内 + 窗口内无推进证据（MSS/BOS） */
function accumulationEvidence({ range, mssEvents, m5, price, now }) {
  // 横盘：4 小时（48 根 5m）效率比 ER = 净位移 / 总路径，来回折返但没走远 → ER 接近 0
  const closed = (m5 || []).filter((k) => k.closeTime <= now);
  const win = closed.slice(-ACCUM_WINDOW_BARS);
  if (win.length < ACCUM_MIN_BARS) return null;
  const er = efficiencyRatio(win);
  if (er >= ACCUM_ER_MAX) return null;

  // 区间框定：现价必须落在当前推动区间（dealingRange）内
  if (!range || range.low == null || range.high == null || range.high <= range.low) return null;
  if (price == null || price < range.low || price > range.high) return null;

  // 无推进证据：窗口内无 5m MSS/BOS 事件（有结构推进 → 不标积累）
  const pushed = (mssEvents || []).some((e) => e && e.time != null && e.time >= now - ACCUM_PUSH_WINDOW_MS);
  if (pushed) return null;

  return { reason: `区间震荡 ER ${er.toFixed(2)}` };
}

/** Kaufman 效率比：净位移 / 总路径长度（0 = 完全折返横盘，1 = 单边推进） */
function efficiencyRatio(candles) {
  if (candles.length < 2) return 1;
  const first = candles[0].close;
  const last = candles[candles.length - 1].close;
  let path = 0;
  for (let i = 1; i < candles.length; i++) path += Math.abs(candles[i].close - candles[i - 1].close);
  if (path === 0) return 0; // 纹丝不动 = 极端横盘
  return Math.abs(last - first) / path;
}

/** 证据有效窗口：默认 24h（一个 AMD 循环周期；实际输入受扫损/位移检测窗口限制，仅为兜底） */
export const AMD_WINDOW_MS = 24 * 60 * 60 * 1000;
/** 积累横盘判定的效率比窗口：48 根 5m ≈ 4 小时（与扫损/位移检测窗口对齐） */
export const ACCUM_WINDOW_BARS = 48;
/** 效率比最小样本：少于 20 根（1.6 小时）不判积累（数据不足） */
export const ACCUM_MIN_BARS = 20;
/** 横盘效率比阈值：ER < 0.25 视为折返无净位移 */
export const ACCUM_ER_MAX = 0.25;
/** 推进证据窗口：4 小时内有 5m MSS/BOS → 不算积累 */
export const ACCUM_PUSH_WINDOW_MS = 4 * 60 * 60 * 1000;
