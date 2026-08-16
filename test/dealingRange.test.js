/**
 * dealingRange（ICT 2022 Impulse Range + 50% Premium/Discount）单元测试
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDealingRange, computeLocationContext, findRecentRange } from "../indicators/dealingRange.js";

const S = (type, price, index) => ({ type, price, index });

test("Case1 Bullish: LOW100→HIGH150→LOW130→HIGH180 → IMPULSE_BULLISH 130-180（最近 HL→HH 推动）", () => {
  const swings = [S("LOW", 100, 0), S("HIGH", 150, 1), S("LOW", 130, 2), S("HIGH", 180, 3)];
  const structure = { direction: "BULLISH" };
  const r = computeDealingRange(swings, structure, 120);

  assert.equal(r.rangeType, "IMPULSE_BULLISH");
  assert.equal(r.low, 130); // 最后一个 HH(180) 之前的最近 LOW
  assert.equal(r.high, 180);
  assert.equal(r.equilibrium, 155);
  assert.equal(r.location, "DISCOUNT"); // 120 < 155
  assert.equal(r.context, "DISCOUNT_VALID");
  // 审计字段：起点 = 回撤低点(HL)，终点 = 结构推进高点(HH)
  assert.equal(r.startReason, "回撤低点(HL)");
  assert.equal(r.endReason, "结构推进高点(HH)");
});

test("Case2 Bearish: HIGH200→LOW150→HIGH170→LOW120 → IMPULSE_BEARISH 170-120（最近 LH→LL 下跌）", () => {
  const swings = [S("HIGH", 200, 0), S("LOW", 150, 1), S("HIGH", 170, 2), S("LOW", 120, 3)];
  const structure = { direction: "BEARISH" };
  const r = computeDealingRange(swings, structure, 160);

  assert.equal(r.rangeType, "IMPULSE_BEARISH");
  assert.equal(r.high, 170); // 最后一个 LL(120) 之前的最近 HIGH
  assert.equal(r.low, 120);
  assert.equal(r.equilibrium, 145);
  assert.equal(r.location, "PREMIUM"); // 160 > 145
  assert.equal(r.context, "PREMIUM_VALID");
  // 审计字段：起点 = 反抽高点(LH)，终点 = 结构推进低点(LL)
  assert.equal(r.startReason, "反抽高点(LH)");
  assert.equal(r.endReason, "结构推进低点(LL)");
});

test("Case3 Fallback: 无结构 → RECENT（最近 swing 高低）", () => {
  const swings = [S("LOW", 90, 0), S("HIGH", 100, 1), S("LOW", 95, 2), S("HIGH", 97, 3)];
  const r = computeDealingRange(swings, null, 98);

  assert.equal(r.rangeType, "RECENT");
  assert.equal(r.low, 95); // 最近 LOW
  assert.equal(r.high, 97); // 最近 HIGH
  assert.equal(r.location, "PREMIUM"); // 98 > (95+97)/2=96
  assert.equal(r.context, "UNKNOWN"); // V1.9：无方向 → 无 context
});

test("Case3b: 结构 NEUTRAL → fallback RECENT", () => {
  const swings = [S("LOW", 90, 0), S("HIGH", 100, 1), S("LOW", 95, 2), S("HIGH", 97, 3)];
  const r = computeDealingRange(swings, { direction: "NEUTRAL" }, 94);
  assert.equal(r.rangeType, "RECENT");
  assert.equal(r.low, 95);
  assert.equal(r.high, 97);
  assert.equal(r.location, "DISCOUNT"); // 94 < 96
  assert.equal(r.context, "UNKNOWN"); // V1.9：NEUTRAL 无方向 → 无 context
});

test("Location 计算: 价格高于/低于 equilibrium", () => {
  const swings = [S("LOW", 100, 0), S("HIGH", 200, 1)];
  const d = computeDealingRange(swings, { direction: "BULLISH" }, 50);
  assert.equal(d.location, "DISCOUNT");
  assert.equal(d.context, "DISCOUNT_VALID");
  const p = computeDealingRange(swings, { direction: "BULLISH" }, 250);
  assert.equal(p.location, "PREMIUM");
  assert.equal(p.context, "PREMIUM");
});

test("ICT 50% EQ 边界：不再用40%/60%阈值覆盖Premium/Discount", () => {
  const range = { low: 100, high: 200 };
  const bull = { direction: "BULLISH" };
  const bear = { direction: "BEARISH" };
  assert.equal(computeLocationContext(range, bull, 140, 150), "DISCOUNT_VALID");
  assert.equal(computeLocationContext(range, bull, 149.99, 150), "DISCOUNT_VALID");
  assert.equal(computeLocationContext(range, bull, 150, 150), "AT_EQ");
  assert.equal(computeLocationContext(range, bull, 150.01, 150), "PREMIUM");
  assert.equal(computeLocationContext(range, bear, 149.99, 150), "DISCOUNT");
  assert.equal(computeLocationContext(range, bear, 150, 150), "AT_EQ");
  assert.equal(computeLocationContext(range, bear, 150.01, 150), "PREMIUM_VALID");
});

test("有区间但没有当前价格 → Location/Context 保持 UNKNOWN", () => {
  const swings = [S("LOW", 100, 0), S("HIGH", 200, 1)];
  const r = computeDealingRange(swings, { direction: "BULLISH" });
  assert.equal(r.location, "UNKNOWN");
  assert.equal(r.context, "UNKNOWN");
  assert.equal(r.position, null);
});

test("无高低点 → UNKNOWN / NONE", () => {
  const r = computeDealingRange([], null, 100);
  assert.equal(r.location, "UNKNOWN");
  assert.equal(r.rangeType, "NONE");
  assert.equal(r.context, "UNKNOWN");
});
