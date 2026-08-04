/**
 * explanation.test.js — V2.1 Bias Explanation Chain
 *
 * buildExplanation 只翻译引擎已算出的组件，不重新计算、不改变判定。
 * 输出固定 5 段：Structure / Liquidity / Location / PD Array / Invalidation。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExplanation } from "../engine/explanation.js";
import { computeDailyBias } from "../engine/dailyBiasEngine.js";

const structBull = { direction: "BULLISH", type: "EXTERNAL_BULLISH", protectedLow: 100 };
const structBear = { direction: "BEARISH", type: "EXTERNAL_BEARISH", protectedHigh: 90 };
const structNeutral = { direction: "NEUTRAL", type: "RANGE" };

const drawBull = {
  side: "BSL",
  primary: { type: "PWH", price: 200, reason: "Previous Week High (HTF objective)" },
  alternatives: [{ type: "PDH", price: 180 }],
};
const drawBear = { side: "SSL", primary: { type: "PDL", price: 80, reason: "Previous Day Low" }, alternatives: [] };

const locValidDiscount = { location: "DISCOUNT", context: "DISCOUNT_VALID", high: 180, low: 100, equilibrium: 140 };
const locValidPremium = { location: "PREMIUM", context: "PREMIUM_VALID", high: 180, low: 100, equilibrium: 140 };

const pdBull = { primary: { type: "BULLISH_FVG", price: 120, top: 125, bottom: 120, location: "DISCOUNT", status: "VALID" }, alternatives: [] };
const pdBear = { primary: { type: "BEARISH_FVG", price: 95, top: 95, bottom: 90, location: "PREMIUM", status: "VALID" }, alternatives: [] };

const invBull = { type: "BREAK_PROTECTED_LOW", price: 100, invalidationType: "STRUCTURE_PROTECTED_LOW", source: "HL_BEFORE_DISPLACEMENT" };
const invBear = { type: "BREAK_PROTECTED_HIGH", price: 90, invalidationType: "STRUCTURE_PROTECTED_HIGH", source: "LH_BEFORE_DISPLACEMENT" };

test("BULLISH 完整链：5 段组件与关键措辞", () => {
  const e = buildExplanation({ structure: structBull, draw: drawBull, location: locValidDiscount, pdArray: pdBull, bias: "BULLISH", invalidation: invBull, structureStatus: "VALID" });
  assert.equal(e.length, 5);
  assert.deepEqual(e.map((x) => x.component), ["Structure", "Liquidity", "Location", "PD Array", "Invalidation"]);

  assert.equal(e[0].lines[0], "HH + HL confirmed — EXTERNAL_BULLISH");
  assert.equal(e[1].lines[0], "Buy-side above: PWH 200 (Previous Week High (HTF objective))");
  assert.equal(e[1].lines[1], "Alternatives: PDH 180");
  assert.deepEqual(e[2].lines, ["Price in DISCOUNT — DISCOUNT_VALID", "valid discount zone (READY for longs)"]);
  assert.equal(e[3].lines[0], "Bullish FVG 120-125 — DISCOUNT, VALID");
  assert.equal(e[4].lines[0], "Protected Low 100 — break = bias invalidated [HL_BEFORE_DISPLACEMENT]");
});

test("BEARISH 完整链：对称措辞", () => {
  const e = buildExplanation({ structure: structBear, draw: drawBear, location: locValidPremium, pdArray: pdBear, bias: "BEARISH", invalidation: invBear, structureStatus: "VALID" });
  assert.equal(e[0].lines[0], "LH + LL confirmed — EXTERNAL_BEARISH");
  assert.equal(e[1].lines[0], "Sell-side below: PDL 80 (Previous Day Low)");
  assert.deepEqual(e[2].lines, ["Price in PREMIUM — PREMIUM_VALID", "valid premium zone (READY for shorts)"]);
  assert.equal(e[3].lines[0], "Bearish FVG 90-95 — PREMIUM, VALID");
  assert.equal(e[4].lines[0], "Protected High 90 — break = bias invalidated [LH_BEFORE_DISPLACEMENT]");
});

test("NEUTRAL：结构未确认，其余组件给出占位措辞", () => {
  const e = buildExplanation({ structure: structNeutral, draw: null, location: { location: "UNKNOWN", context: "UNKNOWN" }, pdArray: null, bias: "NEUTRAL", invalidation: null, structureStatus: "VALID" });
  assert.ok(e[0].lines[0].includes("not confirmed"));
  assert.equal(e[1].lines[0], "-");
  assert.equal(e[2].lines[0], "Price location unknown");
  assert.equal(e[3].lines[0], "No direction — no execution zone");
  assert.equal(e[4].lines[0], "-");
});

test("LATE_IMPULSE：Location 解释为不追（WAIT）", () => {
  const e = buildExplanation({ structure: structBull, draw: drawBull, location: { location: "DISCOUNT", context: "LATE_IMPULSE" }, pdArray: pdBull, bias: "BULLISH", invalidation: invBull, structureStatus: "VALID" });
  assert.deepEqual(e[2].lines, ["Price in DISCOUNT — LATE_IMPULSE", "near range target — avoid chasing (WAIT)"]);
});

test("无 Draw → Liquidity 说明无目标", () => {
  const e = buildExplanation({ structure: structBull, draw: null, location: locValidDiscount, pdArray: pdBull, bias: "BULLISH", invalidation: invBull, structureStatus: "VALID" });
  assert.equal(e[1].lines[0], "No buy-side liquidity above");
});

test("INVALIDATED：Structure 与 Location 均标注结构失效", () => {
  const e = buildExplanation({ structure: structBull, draw: drawBull, location: locValidDiscount, pdArray: pdBull, bias: "BULLISH", invalidation: invBull, structureStatus: "INVALIDATED" });
  assert.equal(e[0].lines[1], "Protected level broken — structure INVALIDATED");
  assert.equal(e[2].lines[1], "structure invalidated — no execution");
});

test("Engine 集成：computeDailyBias 输出 5 段 explanation，不影响 scenario/confidence", () => {
  const r = computeDailyBias({
    structure: structBull,
    liquidity: { buySide: [{ type: "PWH", price: 200 }], sellSide: [], primaryBuyDraw: { type: "PWH", price: 200 }, primarySellDraw: null },
    location: locValidDiscount,
    price: 120,
    pdArray: { fvg: [{ type: "BULLISH_FVG", direction: "BULLISH", top: 125, bottom: 120, index: 5 }], ob: [] },
    htfDirection: "BULLISH",
  });
  assert.equal(r.explanation.length, 5);
  assert.equal(r.explanation[0].component, "Structure");
  assert.equal(r.explanation[4].component, "Invalidation");
  assert.ok(r.explanation[0].lines[0].includes("HH + HL"));
  assert.equal(r.scenario.state, "TREND_CONTINUATION"); // V2.0 输出不受影响
  assert.equal(r.confidence.level, "MEDIUM"); // V2.3：VALID 回撤位 + Wide range 后 55 分
});
