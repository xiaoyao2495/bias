/**
 * dealingRange.js — Premium / Discount（Impulse Range V1.8 + Location Context V1.9）
 *
 * 区间 = 最近一次推动波段（impulsive move），而不是整个大趋势：
 *
 *   BULLISH  → IMPULSE_BULLISH：最近一个 HH + 其之前最近的 LOW（HL/LL 均可）
 *              即"最后一次 HL/LL → HH 推动"的范围
 *   BEARISH  → IMPULSE_BEARISH：最近一个 LL + 其之前最近的 HIGH（LH/HH 均可）
 *              即"最后一次 LH/HH → LL 下跌"的范围
 *   NEUTRAL / 无有效推动 → RECENT fallback：最近一个 Swing High + 最近一个 Swing Low
 *
 *   equilibrium = (high + low) / 2
 *   price > eq → PREMIUM（溢价区，适合找空）
 *   price < eq → DISCOUNT（折价区，适合找多）
 *
 * V1.9 Location Context：Location 只分 PREMIUM/DISCOUNT 信息不足。
 * 增加 context 区分"有效折价/溢价区"与"接近目标（推动末端）"：
 *
 *   BULLISH（目标 = range.high）：
 *     price > high - 60%·span → LATE_IMPULSE（距目标 < 60%，推动进入末端，不追多）
 *     price < equilibrium      → DISCOUNT_VALID（有效折价区）
 *     其余（溢价未接近目标）    → PREMIUM（等回撤）
 *   BEARISH（目标 = range.low）对称：
 *     price < low + 60%·span  → LATE_IMPULSE
 *     price > equilibrium     → PREMIUM_VALID（有效溢价区）
 *     其余                     → DISCOUNT
 *
 * 阈值说明（V1.9 人工裁定）：25% 会让 BTC 2025-10-06（距高点 53%）保持 READY；
 * 采用 60% 才能同时满足 4 例审计预期（10-06 → WAIT、ETH 06-10 → READY 等）。
 */
import { analyzeSwings } from "./swing.js";

/** V1.9：距目标 < 60% 区间高度 → 视为接近目标（推动末端） */
const LATE_IMPULSE_THRESHOLD = 0.6;

export function computeDealingRange(swings, structure, price) {
  const range = findImpulseRange(swings, structure) || findRecentRange(swings);

  if (!range) {
    return { high: null, low: null, equilibrium: null, location: "UNKNOWN", rangeType: "NONE", context: "UNKNOWN", startReason: null, endReason: null };
  }

  const equilibrium = (range.high + range.low) / 2;
  let location = "AT_EQ";
  if (price > equilibrium) location = "PREMIUM";
  else if (price < equilibrium) location = "DISCOUNT";

  const context = computeLocationContext(range, structure, price, equilibrium);

  return { high: range.high, low: range.low, equilibrium, location, rangeType: range.type, context, startReason: range.startReason || null, endReason: range.endReason || null };
}

/**
 * V1.9 Location Context：在 Location 基础上细分执行语义。
 * 只依赖方向、价格与区间；不参与 Bias 判断（Bias 仍只由 Structure 决定）。
 */
export function computeLocationContext(range, structure, price, equilibrium) {
  const dir = structure && structure.direction;
  if (dir !== "BULLISH" && dir !== "BEARISH") return "UNKNOWN";
  const span = range.high - range.low;
  if (!span || span <= 0) return "UNKNOWN";

  if (dir === "BULLISH") {
    if (price > range.high - LATE_IMPULSE_THRESHOLD * span) return "LATE_IMPULSE";
    if (price < equilibrium) return "DISCOUNT_VALID";
    return "PREMIUM";
  }
  if (price < range.low + LATE_IMPULSE_THRESHOLD * span) return "LATE_IMPULSE";
  if (price > equilibrium) return "PREMIUM_VALID";
  return "DISCOUNT";
}

/**
 * V1.8 Impulse Range：最近一次推动波段。
 *   BULLISH : 最后一个 HH 与其之前最近的 LOW → { low: LOW, high: HH }
 *   BEARISH : 最后一个 LL 与其之前最近的 HIGH → { low: LL, high: HIGH }
 * 支持直接传入已打标的 swings（带 label），否则内部调用 analyzeSwings 打标。
 *
 * 审计字段 startReason / endReason（ICT 2022：Impulse = Liquidity → Displacement → Expansion）：
 *   描述区间起点/终点 swing 的结构语义（是回撤位、外部启动位还是结构推进位），
 *   供消息/日志说清"这个区间从哪来、被什么推到哪"，不改任何行为。
 */
export function findImpulseRange(swings, structure) {
  if (!structure || (structure.direction !== "BULLISH" && structure.direction !== "BEARISH")) {
    return null;
  }

  const labeled = swings.length && swings[0].label ? swings : analyzeSwings(swings);

  if (structure.direction === "BULLISH") {
    let hh = null;
    let low = null;
    for (let i = labeled.length - 1; i >= 0; i--) {
      const s = labeled[i];
      if (!hh && s.type === "HIGH" && s.label === "HH") hh = s;
      else if (hh && s.type === "LOW") {
        low = s;
        break;
      }
    }
    if (hh && low) {
      return {
        high: hh.price,
        low: low.price,
        highIndex: hh.index,
        lowIndex: low.index,
        type: "IMPULSE_BULLISH",
        startReason: low.label === "LL" ? "外部结构启动低点(LL)" : "回撤低点(HL)",
        endReason: "结构推进高点(HH)",
      };
    }
  } else if (structure.direction === "BEARISH") {
    let ll = null;
    let high = null;
    for (let i = labeled.length - 1; i >= 0; i--) {
      const s = labeled[i];
      if (!ll && s.type === "LOW" && s.label === "LL") ll = s;
      else if (ll && s.type === "HIGH") {
        high = s;
        break;
      }
    }
    if (ll && high) {
      return {
        high: high.price,
        low: ll.price,
        highIndex: high.index,
        lowIndex: ll.index,
        type: "IMPULSE_BEARISH",
        startReason: high.label === "HH" ? "外部结构启动高点(HH)" : "反抽高点(LH)",
        endReason: "结构推进低点(LL)",
      };
    }
  }

  return null;
}

/** fallback：最近一个 Swing High 与最近一个 Swing Low */
export function findRecentRange(swings) {
  let high = null;
  let low = null;
  for (const s of swings) {
    if (s.type === "HIGH") high = s;
    else if (s.type === "LOW") low = s;
  }

  if (!high || !low) return null;
  return {
    high: high.price,
    low: low.price,
    highIndex: high.index,
    lowIndex: low.index,
    type: "RECENT",
    startReason: "最近摆动低点",
    endReason: "最近摆动高点",
  };
}
