/**
 * dealingRangeImpulse.test.js — V1.8 Impulse Range 测试
 *
 * 用户指定案例：
 *   Case1 BTC 熊市: HH 126000 → LH 104000 → LL 94000  → IMPULSE_BEARISH 104000-94000
 *   Case2 ETH 反弹: LL 1600  → HL 1700   → HH 1900    → IMPULSE_BULLISH 1700-1900
 *   Case3 无有效 impulse → fallback RECENT
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findImpulseRange, computeDealingRange } from "../indicators/dealingRange.js";

const S = (type, price, index, label) => ({ type, price, index, label });

test("Case1 BTC 熊市: HH126000→LH104000→LL94000 → IMPULSE_BEARISH high 104000 low 94000", () => {
  const labeled = [
    S("HIGH", 126000, 10, "HH"),
    S("HIGH", 104000, 20, "LH"),
    S("LOW", 94000, 30, "LL"),
  ];
  const r = findImpulseRange(labeled, { direction: "BEARISH" });
  assert.equal(r.type, "IMPULSE_BEARISH");
  assert.equal(r.high, 104000); // 最后一个 LL 之前的最近 HIGH
  assert.equal(r.low, 94000);
});

test("Case2 ETH 反弹: LL1600→HL1700→HH1900 → IMPULSE_BULLISH low 1700 high 1900", () => {
  const labeled = [
    S("LOW", 1600, 10, "LL"),
    S("LOW", 1700, 20, "HL"),
    S("HIGH", 1900, 30, "HH"),
  ];
  const r = findImpulseRange(labeled, { direction: "BULLISH" });
  assert.equal(r.type, "IMPULSE_BULLISH");
  assert.equal(r.low, 1700); // 最后一个 HH 之前的最近 LOW
  assert.equal(r.high, 1900);
});

test("Case3 无有效 impulse → fallback RECENT", () => {
  // NEUTRAL 结构 → findImpulseRange null → computeDealingRange fallback RECENT
  const swings = [S("LOW", 90, 0), S("HIGH", 100, 1), S("LOW", 95, 2), S("HIGH", 97, 3)];
  const r = computeDealingRange(swings, { direction: "NEUTRAL" }, 94);
  assert.equal(r.rangeType, "RECENT");
  assert.equal(r.low, 95);
  assert.equal(r.high, 97);
  assert.equal(r.context, "UNKNOWN"); // V1.9：NEUTRAL 无方向
});

test("Case4 未打标 swings 也能计算（内部打标）", () => {
  // 原始 swing 无 label：LOW 1600 → LOW 1700 → HIGH 1900（analyzeSwings 打标）
  const swings = [
    { type: "LOW", price: 1600, index: 10 },
    { type: "LOW", price: 1700, index: 20 },
    { type: "HIGH", price: 1900, index: 30 },
  ];
  const r = findImpulseRange(swings, { direction: "BULLISH" });
  assert.equal(r.type, "IMPULSE_BULLISH");
  assert.equal(r.low, 1700);
  assert.equal(r.high, 1900);
});

test("Case5 结构 BULLISH 但无 HH → findImpulseRange null（fallback RECENT 也需高低点齐备）", () => {
  const swings = [S("LOW", 100, 0, "LL"), S("LOW", 120, 1, "HL")];
  const r = findImpulseRange(swings, { direction: "BULLISH" });
  assert.equal(r, null);
  // 无 HIGH swing → findRecentRange 也不成立 → NONE
  const c = computeDealingRange(swings, { direction: "BULLISH" }, 110);
  assert.equal(c.rangeType, "NONE");
  assert.equal(c.context, "UNKNOWN");
});
