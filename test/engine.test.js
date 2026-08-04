/**
 * dailyBiasEngine 单元测试（V1.3：方向与位置拆离）
 *
 * Market Bias 只由 Structure 决定；Location 只影响 Execution State。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDailyBias } from "../engine/dailyBiasEngine.js";

const bullishStruct = {
  direction: "BULLISH",
  protectedLow: 100,
  protectedLowInfo: { invalidationType: "STRUCTURE_PROTECTED_LOW", source: "HL_BEFORE_DISPLACEMENT" },
};
const bearishStruct = {
  direction: "BEARISH",
  protectedHigh: 90,
  protectedHighInfo: { invalidationType: "STRUCTURE_PROTECTED_HIGH", source: "LH_BEFORE_DISPLACEMENT" },
};
const neutralStruct = { direction: "NEUTRAL", protectedLow: null };

const liqBull = {
  buySide: [{ type: "PWH", price: 120 }],
  sellSide: [],
  primaryBuyDraw: { type: "PWH", price: 120 },
  primarySellDraw: null,
};
const liqBear = {
  buySide: [],
  sellSide: [{ type: "PDL", price: 80 }],
  primaryBuyDraw: null,
  primarySellDraw: { type: "PDL", price: 80 },
};
const liqNone = { buySide: [], sellSide: [], primaryBuyDraw: null, primarySellDraw: null };

// ---- 用户要求的 4 个方向 × 位置组合 ----

test("Bullish + Discount → Bias BULLISH，Execution READY", () => {
  const r = computeDailyBias({ structure: bullishStruct, liquidity: liqBull, location: { location: "DISCOUNT" } });
  assert.equal(r.bias, "BULLISH");
  assert.equal(r.executionState, "READY");
  assert.equal(r.draw.side, "BSL");
  assert.equal(r.draw.primary.type, "PWH");
  assert.deepEqual(r.draw.alternatives, []);
  assert.ok(r.reason.includes("Price in discount — execution READY (look for longs)"));
  assert.deepEqual(r.invalidation, {
    type: "BREAK_PROTECTED_LOW",
    price: 100,
    invalidationType: "STRUCTURE_PROTECTED_LOW",
    source: "HL_BEFORE_DISPLACEMENT",
  });
});

test("Bullish + Premium → Bias BULLISH，Execution WAIT", () => {
  const r = computeDailyBias({ structure: bullishStruct, liquidity: liqBull, location: { location: "PREMIUM" } });
  assert.equal(r.bias, "BULLISH");
  assert.equal(r.executionState, "WAIT");
  assert.ok(r.reason.some((x) => x.includes("WAIT (wait for discount retracement)")));
});

test("Bearish + Premium → Bias BEARISH，Execution READY", () => {
  const r = computeDailyBias({ structure: bearishStruct, liquidity: liqBear, location: { location: "PREMIUM" } });
  assert.equal(r.bias, "BEARISH");
  assert.equal(r.executionState, "READY");
  assert.equal(r.draw.side, "SSL");
  assert.equal(r.draw.primary.type, "PDL");
  assert.deepEqual(r.draw.alternatives, []);
  assert.ok(r.reason.includes("Price in premium — execution READY (look for shorts)"));
  assert.deepEqual(r.invalidation, {
    type: "BREAK_PROTECTED_HIGH",
    price: 90,
    invalidationType: "STRUCTURE_PROTECTED_HIGH",
    source: "LH_BEFORE_DISPLACEMENT",
  });
});

test("Bearish + Discount → Bias BEARISH，Execution WAIT", () => {
  const r = computeDailyBias({ structure: bearishStruct, liquidity: liqBear, location: { location: "DISCOUNT" } });
  assert.equal(r.bias, "BEARISH");
  assert.equal(r.executionState, "WAIT");
  assert.ok(r.reason.some((x) => x.includes("WAIT (wait for premium retracement)")));
});

// ---- 边界 ----

test("BULLISH: 无上方 BSL → bias 仍 BULLISH，draw 为 null", () => {
  const r = computeDailyBias({ structure: bullishStruct, liquidity: liqNone, location: { location: "DISCOUNT" } });
  assert.equal(r.bias, "BULLISH");
  assert.equal(r.draw, null);
  assert.ok(r.reason.some((x) => x.includes("No buy-side liquidity")));
});

test("BEARISH: 无下方 SSL → bias 仍 BEARISH，draw 为 null", () => {
  const r = computeDailyBias({ structure: bearishStruct, liquidity: liqNone, location: { location: "PREMIUM" } });
  assert.equal(r.bias, "BEARISH");
  assert.equal(r.draw, null);
  assert.ok(r.reason.some((x) => x.includes("No sell-side liquidity")));
});

test("NEUTRAL: Structure 未确认 → bias NEUTRAL", () => {
  const r = computeDailyBias({ structure: neutralStruct, liquidity: liqBull, location: { location: "DISCOUNT" } });
  assert.equal(r.bias, "NEUTRAL");
  assert.equal(r.executionState, "NONE");
  assert.equal(r.invalidation, null);
});

test("Location UNKNOWN → executionState NONE", () => {
  const r = computeDailyBias({ structure: bullishStruct, liquidity: liqBull, location: { location: "UNKNOWN" } });
  assert.equal(r.bias, "BULLISH");
  assert.equal(r.executionState, "NONE");
});

// ---- V1.4.1 Protected Structure Validation ----

test("BULLISH + price > protectedLow → structureStatus VALID，effectiveBias BULLISH", () => {
  const r = computeDailyBias({ structure: bullishStruct, liquidity: liqBull, location: { location: "DISCOUNT" }, price: 110 });
  assert.equal(r.bias, "BULLISH");
  assert.equal(r.structureStatus, "VALID");
  assert.equal(r.effectiveBias, "BULLISH");
  assert.equal(r.executionState, "READY");
});

test("BULLISH + price < protectedLow → structureStatus INVALIDATED，effectiveBias NEUTRAL", () => {
  const r = computeDailyBias({ structure: bullishStruct, liquidity: liqBull, location: { location: "DISCOUNT" }, price: 90 });
  assert.equal(r.bias, "BULLISH"); // 原始方向保留（审计）
  assert.equal(r.structureStatus, "INVALIDATED");
  assert.equal(r.effectiveBias, "NEUTRAL");
  assert.equal(r.executionState, "NONE"); // 失效后不再 READY
  assert.ok(r.reason.some((x) => x.includes("Protected low broken")));
});

test("BEARISH + price < protectedHigh → VALID，effectiveBias BEARISH", () => {
  const r = computeDailyBias({ structure: bearishStruct, liquidity: liqBear, location: { location: "PREMIUM" }, price: 85 });
  assert.equal(r.structureStatus, "VALID");
  assert.equal(r.effectiveBias, "BEARISH");
  assert.equal(r.executionState, "READY");
});

test("BEARISH + price > protectedHigh → INVALIDATED，effectiveBias NEUTRAL", () => {
  const r = computeDailyBias({ structure: bearishStruct, liquidity: liqBear, location: { location: "PREMIUM" }, price: 95 });
  assert.equal(r.bias, "BEARISH");
  assert.equal(r.structureStatus, "INVALIDATED");
  assert.equal(r.effectiveBias, "NEUTRAL");
  assert.equal(r.executionState, "NONE");
  assert.ok(r.reason.some((x) => x.includes("Protected high broken")));
});

test("无 price → 不校验，structureStatus VALID", () => {
  const r = computeDailyBias({ structure: bullishStruct, liquidity: liqBull, location: { location: "DISCOUNT" } });
  assert.equal(r.structureStatus, "VALID");
  assert.equal(r.effectiveBias, "BULLISH");
});

// ---- V1.9 Location Context ----

test("Bullish + DISCOUNT + LATE_IMPULSE（接近目标/推动末端）→ Execution WAIT", () => {
  const r = computeDailyBias({ structure: bullishStruct, liquidity: liqBull, location: { location: "DISCOUNT", context: "LATE_IMPULSE" } });
  assert.equal(r.bias, "BULLISH"); // Bias 不变
  assert.equal(r.executionState, "WAIT"); // 不追多
  assert.ok(r.reason.some((x) => x.includes("LATE_IMPULSE")));
});

test("Bullish + DISCOUNT + DISCOUNT_VALID → Execution READY", () => {
  const r = computeDailyBias({ structure: bullishStruct, liquidity: liqBull, location: { location: "DISCOUNT", context: "DISCOUNT_VALID" } });
  assert.equal(r.executionState, "READY");
  assert.ok(r.reason.some((x) => x.includes("execution READY (look for longs)")));
});

test("Bullish + PREMIUM + LATE_IMPULSE → Execution WAIT（context 覆盖 location）", () => {
  const r = computeDailyBias({ structure: bullishStruct, liquidity: liqBull, location: { location: "PREMIUM", context: "LATE_IMPULSE" } });
  assert.equal(r.executionState, "WAIT");
});

test("Bearish + PREMIUM + LATE_IMPULSE（接近低点目标/推动末端）→ Execution WAIT", () => {
  const r = computeDailyBias({ structure: bearishStruct, liquidity: liqBear, location: { location: "PREMIUM", context: "LATE_IMPULSE" } });
  assert.equal(r.bias, "BEARISH");
  assert.equal(r.executionState, "WAIT"); // 不追空
  assert.ok(r.reason.some((x) => x.includes("LATE_IMPULSE")));
});

test("Bearish + PREMIUM + PREMIUM_VALID → Execution READY", () => {
  const r = computeDailyBias({ structure: bearishStruct, liquidity: liqBear, location: { location: "PREMIUM", context: "PREMIUM_VALID" } });
  assert.equal(r.executionState, "READY");
  assert.ok(r.reason.some((x) => x.includes("execution READY (look for shorts)")));
});
