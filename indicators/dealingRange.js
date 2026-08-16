/**
 * dealingRange.js — ICT 2022 Premium / Discount（Impulse Range）
 *
 * 区间 = 最近一次推动波段（impulsive move），而不是整个大趋势：
 *
 *   BULLISH  → IMPULSE_BULLISH：最近一个 HH + 其之前最近的 LOW（HL/LL 均可）
 *              即"最后一次 HL/LL → HH 推动"的范围
 *   BEARISH  → IMPULSE_BEARISH：最近一个 LL + 其之前最近的 HIGH（LH/HH 均可）
 *              即"最后一次 LH/HH → LL 下跌"的范围
 *   NEUTRAL / 无有效推动 → RECENT observation：最近一个 Swing High + 最近一个 Swing Low；
 *              只供画图/审计，不进入 Location、ERL/IRL、PD Array 或通知因果链
 *
 *   equilibrium = (high + low) / 2
 *   price > eq → PREMIUM（溢价区，适合找空）
 *   price < eq → DISCOUNT（折价区，适合找多）
 *
 * 位置语义只使用 50% Equilibrium：低于 EQ = Discount，高于 EQ = Premium。
 * “推动末端/是否追价”不是 ICT Dealing Range 的第三种位置，不在这里使用任意 40%/60%
 * 阈值覆盖 Premium/Discount；交易空间由 Draw、失效位和 planR 在决策层单独判断。
 */
import { analyzeSwings } from "./swing.js";

export const IMPULSE_DEALING_RANGE_TYPES = Object.freeze(["IMPULSE_BULLISH", "IMPULSE_BEARISH"]);

/** RECENT 只是观察候选；只有明确推动腿才有资格进入交易、流动性与通知主链。 */
export function isImpulseDealingRange(range) {
  return !!range && IMPULSE_DEALING_RANGE_TYPES.includes(range.rangeType);
}

/** 生命周期已确认且仍有效的推动区间。 */
export function isActiveDealingRange(range) {
  return isImpulseDealingRange(range)
    && !!range.rangeId
    && range.lifecycleStatus === "ACTIVE"
    && range.tradable !== false;
}

export function computeDealingRange(swings, structure, price, liquidity) {
  const range = findImpulseRange(swings, structure, liquidity) || findRecentRange(swings);

  if (!range) {
    return { high: null, low: null, equilibrium: null, location: "UNKNOWN", rangeType: "NONE", context: "UNKNOWN", startReason: null, endReason: null, position: null };
  }

  const equilibrium = (range.high + range.low) / 2;
  const current = Number(price);
  const hasPrice = Number.isFinite(current);
  let location = hasPrice ? "AT_EQ" : "UNKNOWN";
  if (hasPrice && current > equilibrium) location = "PREMIUM";
  else if (hasPrice && current < equilibrium) location = "DISCOUNT";
  // 连续位置（通用位置度量）：0 = 区间低点，1 = 区间高点，0.5 = 中点。
  // 不做 clamp（价格突破区间时 >1 / <0 本身是有意义的信息，消费方可自行截断）。
  const position = hasPrice && range.high > range.low ? (current - range.low) / (range.high - range.low) : null;

  const context = computeLocationContext(range, structure, current, equilibrium);

  return {
    high: range.high,
    low: range.low,
    equilibrium,
    location,
    rangeType: range.type,
    context,
    startReason: range.startReason || null,
    endReason: range.endReason || null,
    position,
    // ERL/IRL 必须与同一个 dealing range 共用端点和形成时间，不能再从 structure
    // 另找一组所谓“external”价位。索引用于等待 pivot 右侧确认，杜绝未来函数。
    highIndex: range.highIndex ?? null,
    lowIndex: range.lowIndex ?? null,
    highTime: range.highTime ?? null,
    lowTime: range.lowTime ?? null,
  };
}

/**
 * 兼容字段 context：只表达当前位置是否与结构方向的 Premium/Discount 顺位一致。
 * 不再产生 LATE_IMPULSE；是否追价由实际 Draw/Risk 的 planR 决定。
 */
export function computeLocationContext(range, structure, price, equilibrium) {
  const dir = structure && structure.direction;
  if (dir !== "BULLISH" && dir !== "BEARISH") return "UNKNOWN";
  const current = Number(price);
  const eq = Number.isFinite(Number(equilibrium)) ? Number(equilibrium) : (Number(range.high) + Number(range.low)) / 2;
  if (!(range.high > range.low) || !Number.isFinite(current) || !Number.isFinite(eq)) return "UNKNOWN";
  if (current === eq) return "AT_EQ";
  if (dir === "BULLISH") {
    if (current < eq) return "DISCOUNT_VALID";
    return "PREMIUM";
  }
  if (current > eq) return "PREMIUM_VALID";
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
 *   传入 liquidity 时进一步核对起点是否命中"已被扫损的流动性位"（SWEPT）：
 *   若区间起点就是被扫掉的下方/上方流动性（SSL/BSL Sweep 后启动的推动），
 *   用"扫下方流动性后启动"这类描述，体现 Impulse 的流动性源头（仍为审计字段，无行为变化）。
 */
export function findImpulseRange(swings, structure, liquidity) {
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
        highTime: hh.time ?? null,
        lowTime: low.time ?? null,
        type: "IMPULSE_BULLISH",
        startReason: sweptLevelReason(liquidity, "SELL", low.price) || (low.label === "LL" ? "外部结构启动低点(LL)" : "回撤低点(HL)"),
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
        highTime: high.time ?? null,
        lowTime: ll.time ?? null,
        type: "IMPULSE_BEARISH",
        startReason: sweptLevelReason(liquidity, "BUY", high.price) || (high.label === "HH" ? "外部结构启动高点(HH)" : "反抽高点(LH)"),
        endReason: "结构推进低点(LL)",
      };
    }
  }

  return null;
}

/**
 * 检查区间起点是否命中已被扫损的流动性位（state === "SWEPT"）：
 * 是则用"扫流动性后启动"描述区间来源，体现 Impulse 的流动性源头。
 * side: "SELL" = 下方流动性位（sellSide，扫下方后启动多头推动）；"BUY" = 上方（buySide）。
 * 容差 0.1%：流动性位与 swing 价格存在小偏差，取近似命中。
 */
function sweptLevelReason(liquidity, side, price) {
  if (!liquidity) return null;
  const levels = side === "SELL" ? liquidity.sellSide || [] : liquidity.buySide || [];
  const hit = levels.find((l) => l && l.price != null && Math.abs(l.price - price) < price * 0.001 && l.state === "SWEPT");
  if (!hit) return null;
  return side === "SELL" ? "扫下方流动性后启动(SSL Sweep)" : "扫上方流动性后启动(BSL Sweep)";
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
    highTime: high.time ?? null,
    lowTime: low.time ?? null,
    type: "RECENT",
    startReason: "最近摆动低点",
    endReason: "最近摆动高点",
  };
}
