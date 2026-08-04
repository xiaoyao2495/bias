/**
 * swing.js — 摆动点识别：Swing High / Swing Low
 *
 * 简单 Pivot（5 根 K，左右各 2）：
 *   若 K3.high > K1,K2,K4,K5 的 high → Swing High
 *   若 K3.low  < K1,K2,K4,K5 的 low  → Swing Low
 *
 * 输出：
 *   { type: "HIGH"|"LOW", price, index }
 *
 * 再对相邻 Swing 打标：HH / HL / LH / LL
 */

/** 识别摆动点（默认 left=2, right=2） */
export function findSwings(candles, left = 2, right = 2) {
  const swings = [];
  if (candles.length < left + right + 1) return swings;

  for (let i = left; i < candles.length - right; i++) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (candles[j].high >= c.high) isHigh = false;
      if (candles[j].low <= c.low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) swings.push({ type: "HIGH", price: c.high, index: i });
    else if (isLow) swings.push({ type: "LOW", price: c.low, index: i });
  }

  return dedupeAlternating(swings);
}

/** 保证 HIGH/LOW 交替：连续同类型时保留更极端的那个 */
function dedupeAlternating(swings) {
  if (swings.length === 0) return swings;
  const result = [swings[0]];
  for (let i = 1; i < swings.length; i++) {
    const last = result[result.length - 1];
    const cur = swings[i];
    if (cur.type === last.type) {
      if (cur.type === "HIGH" && cur.price > last.price) result[result.length - 1] = cur;
      else if (cur.type === "LOW" && cur.price < last.price) result[result.length - 1] = cur;
    } else {
      result.push(cur);
    }
  }
  return result;
}

/**
 * 依序比较相邻 Swing 并打标：
 *   比上一个高点更高 → HH，更低 → LH
 *   比上一个低点更高 → HL，更低 → LL
 * 第一个同类型 Swing 无比较基准，先标 HH / LL（不参与方向判定时会被忽略）
 */
export function analyzeSwings(swings) {
  let lastHigh = null;
  let lastLow = null;
  const labeled = [];

  for (const s of swings) {
    let label;
    if (s.type === "HIGH") {
      label = lastHigh === null ? "HH" : s.price > lastHigh ? "HH" : "LH";
      lastHigh = s.price;
    } else {
      label = lastLow === null ? "LL" : s.price > lastLow ? "HL" : "LL";
      lastLow = s.price;
    }
    labeled.push({ ...s, label });
  }
  return labeled;
}
