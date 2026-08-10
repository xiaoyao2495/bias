/**
 * scenario.js — V2.0 Scenario State（4H 市场状态描述，不是 Entry 信号）
 *
 * 用 1D/1W 结构方向作为 HTF 参照，判断 4H 当前处于哪种状态：
 *
 *   TREND_CONTINUATION : 4H 方向与 HTF 方向一致（顺势推进）
 *   REVERSAL_ATTEMPT   : 4H 方向与 HTF 方向相反（疑似反转尝试）
 *   RANGE              : 4H 结构未确认（无 HH/HL 或 LH/LL）
 *   TRANSITION         : 结构保护位被穿透 / HTF 无方向（方向待确认）
 */
import { findSwings, analyzeSwings } from "./swing.js";
import { buildStructure } from "./structure.js";

/**
 * 计算 HTF 方向：按 日线 → 周线 → 月线（周线聚合）逐级兜底。
 * 日线结构在拐点区域常因单个 LL/LH 判为 NEUTRAL（如 2025-10 顶部深回调），
 * 逐级回落月线可拿到更稳的 HTF 方向（2025 年大牛 = BULLISH）。
 * 只做参照，不参与 4H Bias 判定。
 *
 * V2.0 修正（BOS 实时修正）：严格 swing 判定在 V 型反转处滞后——最后一根
 * LL/LH 确认后价格已突破（如 ETH 2025-08-13：1D 判 LL+LH=BEARISH，但价格已
 * 突破最后高点 3737 与前高 3941）。用实时价格对最后 swing 高低点做突破修正：
 *   - 判 BEARISH 但 price > lastSwingHigh → 新 HH 形成中 → BULLISH
 *   - 判 BULLISH 但 price < lastSwingLow  → 新 LL 形成中 → BEARISH
 *   - NEUTRAL 时 price 突破最后高点/低点 → 给出方向
 * 10 例验证：仅修正 ETH 2025-08-13（BEARISH→BULLISH），其余 9 例不变。
 *
 * @param {Array} dayCandles  日线 K 线（已按回放时间截断）
 * @param {Array} weekCandles 周线 K 线（已按回放时间截断）
 * @param {number} [price]    当前价格（4H 收盘），用于 BOS 实时修正
 */
export function computeHtfDirection(dayCandles, weekCandles, price) {
  const ctx = computeHtfContext(dayCandles, weekCandles, price);
  // 旧 API 兼容：依然返回实时突破修正后的方向。新的 Bias 主链使用
  // ctx.confirmedDirection，不再把未收盘的 HTF 突破当成已确认方向。
  return ctx.provisionalDirection || ctx.confirmedDirection;
}

/**
 * HTF 上下文：把“已收盘结构”和“当前价格正在突破”拆开。
 * confirmedDirection 按 1D → 1W → 1M 逐级兜底；provisionalDirection 只是预警，
 * 不覆盖已确认的高周期方向。
 */
export function computeHtfContext(dayCandles, weekCandles, price) {
  const frames = [
    analyzeFrame(dayCandles, "1D"),
    analyzeFrame(weekCandles, "1W"),
    analyzeFrame(aggregateMonthly(weekCandles || []), "1M"),
  ];
  const confirmed = frames.find((f) => f.direction !== "NEUTRAL") || frames[0];
  let provisional = provisionalBreak(confirmed, price);

  // 若已确认方向来自周/月线，但日线尚中性且正在突破，优先显示更新的日线预警。
  if (confirmed.timeframe !== "1D") {
    const dailyProvisional = provisionalBreak(frames[0], price);
    if (dailyProvisional) provisional = dailyProvisional;
  }

  return {
    confirmedDirection: confirmed.direction,
    confirmedTimeframe: confirmed.direction === "NEUTRAL" ? null : confirmed.timeframe,
    provisionalDirection: provisional ? provisional.direction : null,
    provisionalTimeframe: provisional ? provisional.timeframe : null,
    provisionalBreak: provisional
      ? { direction: provisional.direction, timeframe: provisional.timeframe, level: provisional.level }
      : null,
  };
}

function analyzeFrame(candles, timeframe) {
  if (!candles || !candles.length) {
    return { timeframe, direction: "NEUTRAL", lastHigh: null, lastLow: null };
  }
  const s = buildStructure(analyzeSwings(findSwings(candles)));
  const lastClose = candles[candles.length - 1]?.close;
  const lastHigh = s.lastHigh ? s.lastHigh.price : null;
  const lastLow = s.lastLow ? s.lastLow.price : null;
  let direction = s.direction;
  // 输入数组只含已收盘 HTF K，因此这里的 close 突破属于已确认 BOS。
  if (lastClose != null && lastHigh != null && lastClose > lastHigh && (direction === "BEARISH" || direction === "NEUTRAL")) direction = "BULLISH";
  if (lastClose != null && lastLow != null && lastClose < lastLow && (direction === "BULLISH" || direction === "NEUTRAL")) direction = "BEARISH";
  return {
    timeframe,
    direction,
    lastHigh,
    lastLow,
  };
}

function provisionalBreak(frame, price) {
  if (!frame || price == null) return null;
  if (frame.lastHigh != null && price > frame.lastHigh && (frame.direction === "BEARISH" || frame.direction === "NEUTRAL")) {
    return { timeframe: frame.timeframe, direction: "BULLISH", level: frame.lastHigh };
  }
  if (frame.lastLow != null && price < frame.lastLow && (frame.direction === "BULLISH" || frame.direction === "NEUTRAL")) {
    return { timeframe: frame.timeframe, direction: "BEARISH", level: frame.lastLow };
  }
  return null;
}

/** 把周线聚合为月线（open=首根 open，high=max，low=min，close=末根 close） */
export function aggregateMonthly(weekCandles) {
  const months = [];
  let cur = null;
  let curKey = null;
  for (const k of weekCandles) {
    const key = new Date(k.time ?? k.closeTime).toISOString().slice(0, 7);
    if (key !== curKey) {
      cur = { time: key, open: k.open, high: k.high, low: k.low, close: k.close, closeTime: k.closeTime };
      months.push(cur);
      curKey = key;
    } else {
      cur.high = Math.max(cur.high, k.high);
      cur.low = Math.min(cur.low, k.low);
      cur.close = k.close;
      cur.closeTime = k.closeTime;
    }
  }
  return months;
}

/**
 * 判定 4H Scenario State。
 *
 * @param {object} p
 * @param {string} p.direction        4H Market Bias（BULLISH/BEARISH/NEUTRAL）
 * @param {string} p.structureStatus  结构保护位状态（VALID/INVALIDATED）
 * @param {string} p.htfDirection     HTF 方向（BULLISH/BEARISH/NEUTRAL）
 */
export function computeScenario({ direction, structureStatus, htfDirection }) {
  const htf = htfDirection || "NEUTRAL";

  if (structureStatus === "INVALIDATED") {
    return {
      state: "TRANSITION",
      label: "TRANSITION",
      htfDirection: htf,
      reason: "Protected level broken — structure INVALIDATED, direction in transition",
    };
  }
  if (direction === "NEUTRAL") {
    return {
      state: "RANGE",
      label: "RANGE",
      htfDirection: htf,
      reason: "4H structure not confirmed (no HH/HL or LH/LL)",
    };
  }
  if (htf === direction) {
    return {
      state: "TREND_CONTINUATION",
      label: `${direction}_CONTINUATION`,
      htfDirection: htf,
      reason: `4H ${direction} aligns with HTF ${htf} — trend continuation`,
    };
  }
  if (htf !== "NEUTRAL") {
    return {
      state: "REVERSAL_ATTEMPT",
      label: `${direction}_REVERSAL_ATTEMPT`,
      htfDirection: htf,
      reason: `4H ${direction} opposes HTF ${htf} — possible reversal attempt`,
    };
  }
  return {
    state: "TRANSITION",
    label: "TRANSITION",
    htfDirection: htf,
    reason: `4H ${direction} but HTF ${htf} — direction not confirmed`,
  };
}
