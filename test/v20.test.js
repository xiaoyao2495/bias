/**
 * v20.test.js — V2.0 HTF Bias Audit & Confidence
 *
 * Scenario State（HTF 参照）：TREND_CONTINUATION / REVERSAL_ATTEMPT / RANGE / TRANSITION
 * Bias Confidence（硬门槛 + 3 项加分）：HIGH / MEDIUM / LOW
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeScenario, computeHtfDirection, computeHtfContext } from "../indicators/scenario.js";
import { computeConfidence } from "../engine/confidence.js";
import { computeDailyBias } from "../engine/dailyBiasEngine.js";

// ---- Scenario State ----

test("4H BULLISH + HTF BULLISH → TREND_CONTINUATION", () => {
  const s = computeScenario({ direction: "BULLISH", structureStatus: "VALID", htfDirection: "BULLISH" });
  assert.equal(s.state, "TREND_CONTINUATION");
  assert.equal(s.label, "BULLISH_CONTINUATION");
});

test("4H BEARISH + HTF BULLISH → REVERSAL_ATTEMPT（方向相反）", () => {
  const s = computeScenario({ direction: "BEARISH", structureStatus: "VALID", htfDirection: "BULLISH" });
  assert.equal(s.state, "REVERSAL_ATTEMPT");
  assert.equal(s.label, "BEARISH_REVERSAL_ATTEMPT");
});

test("4H NEUTRAL → RANGE（无论 HTF）", () => {
  const s = computeScenario({ direction: "NEUTRAL", structureStatus: "VALID", htfDirection: "BEARISH" });
  assert.equal(s.state, "RANGE");
  assert.equal(s.label, "RANGE");
});

test("INVALIDATED → TRANSITION（优先）", () => {
  const s = computeScenario({ direction: "BEARISH", structureStatus: "INVALIDATED", htfDirection: "BEARISH" });
  assert.equal(s.state, "TRANSITION");
});

test("4H 有方向 + HTF NEUTRAL → TRANSITION（无参照，方向未确认）", () => {
  const s = computeScenario({ direction: "BULLISH", structureStatus: "VALID", htfDirection: "NEUTRAL" });
  assert.equal(s.state, "TRANSITION");
});

test("未传 htfDirection → 按 NEUTRAL 处理", () => {
  const s = computeScenario({ direction: "BEARISH", structureStatus: "VALID" });
  assert.equal(s.state, "TRANSITION");
});

// ---- Bias Confidence ----

const struct = { direction: "BULLISH", protectedLow: 100 };
const draw = { primary: { type: "PWH", price: 200 } };
const validLocation = { location: "DISCOUNT", context: "DISCOUNT_VALID" };
const lateLocation = { location: "DISCOUNT", context: "LATE_IMPULSE" };
const wideLocation = { location: "DISCOUNT", context: "DISCOUNT_VALID", high: 200, low: 100 };
const pdAligned = { primary: { type: "BULLISH_FVG", price: 120 } };

const contBull = { state: "TREND_CONTINUATION", label: "BULLISH_CONTINUATION", htfDirection: "BULLISH" };
const revBull = { state: "REVERSAL_ATTEMPT", label: "BULLISH_REVERSAL_ATTEMPT", htfDirection: "BEARISH" };

test("NEUTRAL 结构 → 硬门槛不通过 → LOW, score 0", () => {
  const c = computeConfidence({ bias: "BULLISH", structure: { direction: "NEUTRAL" }, structureStatus: "VALID", draw, location: validLocation, pdArray: pdAligned, price: 120, scenario: contBull });
  assert.equal(c.level, "LOW");
  assert.equal(c.score, 0);
  assert.ok(c.factors.some((f) => f.name === "Structure not confirmed"));
});

test("INVALIDATED → 硬门槛不通过 → LOW, score 0", () => {
  const c = computeConfidence({ bias: "BULLISH", structure: struct, structureStatus: "INVALIDATED", draw, location: validLocation, pdArray: pdAligned, price: 120, scenario: contBull });
  assert.equal(c.level, "LOW");
  assert.equal(c.score, 0);
});

test("CONTINUATION + HTF 同向 + 全质量（VALID 回撤位）→ MEDIUM（score 65）", () => {
  // V2.3 数据修正：VALID 折价/溢价位是负因子（未来 5 天易破保护位）
  const c = computeConfidence({ bias: "BULLISH", structure: struct, structureStatus: "VALID", draw, location: validLocation, pdArray: pdAligned, price: 120, scenario: contBull });
  assert.equal(c.level, "MEDIUM"); // 25+15+25+10−10 = 65 < 75
  assert.equal(c.score, 65);
  assert.equal(c.confluenceScore, 65);
  assert.ok(c.factors.some((f) => f.name === "Retrace location (weak)"));
  assert.deepEqual(c.checks, {
    structureConfirmed: true,
    protectedValid: true,
    liquidityClear: true,
    locationValid: true,
    pdArrayAligned: true,
  });
});

test("CONTINUATION + LATE_IMPULSE + PD aligned → HIGH（趋势惯性为正因子）", () => {
  const c = computeConfidence({ bias: "BULLISH", structure: struct, structureStatus: "VALID", draw, location: lateLocation, pdArray: pdAligned, price: 120, scenario: contBull });
  assert.equal(c.level, "HIGH"); // 25+15+25+10+15 = 90 ≥ 75
  assert.equal(c.score, 90);
  assert.ok(c.factors.some((f) => f.name === "Trend continuation"));
  assert.ok(c.factors.some((f) => f.name === "Late impulse momentum"));
});

test("REVERSAL_ATTEMPT 最多 MEDIUM（反转不默认 HIGH）", () => {
  const c = computeConfidence({ bias: "BULLISH", structure: struct, structureStatus: "VALID", draw, location: lateLocation, pdArray: pdAligned, price: 120, scenario: revBull });
  assert.equal(c.level, "MEDIUM"); // 5−10+25+10+15 = 45 < 75
  assert.equal(c.score, 45);
  assert.ok(c.factors.some((f) => f.name === "HTF conflict"));
});

test("Near Draw Target（<2%）→ +5（近目标惯性）", () => {
  const nearDraw = { primary: { type: "PDH", price: 121 } }; // (121-120)/120 ≈ 0.8%
  const c = computeConfidence({ bias: "BULLISH", structure: struct, structureStatus: "VALID", draw: nearDraw, location: validLocation, pdArray: pdAligned, price: 120, scenario: contBull });
  assert.equal(c.level, "MEDIUM"); // 25+15+25+10−10+5 = 70
  assert.equal(c.score, 70);
  assert.ok(c.factors.some((f) => f.name === "Near draw target"));
});

test("Wide Range（跨度 >25% 价格）→ -10", () => {
  const c = computeConfidence({ bias: "BULLISH", structure: struct, structureStatus: "VALID", draw, location: wideLocation, pdArray: pdAligned, price: 120, scenario: contBull });
  assert.equal(c.level, "MEDIUM"); // 25+15+25+10−10−10 = 55
  assert.equal(c.score, 55);
  assert.ok(c.factors.some((f) => f.name === "Wide range"));
});

// ---- HTF Direction（V2.0 BOS 实时修正）----
// 构造合成 1D K 线：HH 110 → LL 90 → LH 106，之后价格突破 LH 至 119。
// 严格 swing 判定 BEARISH（LL+LH），但价格已突破最后高点 → 应修正为 BULLISH。
const DAY_CANDLES_BREAK_LH = [
  { open: 100, high: 102, low: 98, close: 100 },
  { open: 100, high: 103, low: 99, close: 101 },
  { open: 101, high: 110, low: 100, close: 105 }, // HIGH#1 110 (HH)
  { open: 105, high: 108, low: 103, close: 106 },
  { open: 106, high: 109, low: 104, close: 105 },
  { open: 105, high: 107, low: 102, close: 104 },
  { open: 104, high: 106, low: 101, close: 103 },
  { open: 103, high: 105, low: 100, close: 102 },
  { open: 102, high: 104, low: 99, close: 101 },
  { open: 101, high: 103, low: 90, close: 98 }, // LOW#1 90 (LL)
  { open: 98, high: 101, low: 95, close: 97 },
  { open: 97, high: 102, low: 94, close: 96 },
  { open: 96, high: 103, low: 95, close: 99 },
  { open: 99, high: 106, low: 98, close: 102 }, // HIGH#2 106 (LH)
  { open: 102, high: 105, low: 100, close: 101 },
  { open: 101, high: 104, low: 99, close: 100 },
  { open: 100, high: 120, low: 99, close: 119 }, // 价格突破 LH（V 型反转）
];

// 镜像：LL 90 → HH 110 → HL 94，之后价格跌破 HL 至 92。
const DAY_CANDLES_BREAK_HL = [
  { open: 100, high: 102, low: 98, close: 100 },
  { open: 100, high: 101, low: 97, close: 99 },
  { open: 99, high: 100, low: 96, close: 98 },
  { open: 98, high: 99, low: 90, close: 95 }, // LOW#1 90 (LL)
  { open: 95, high: 102, low: 93, close: 100 },
  { open: 100, high: 104, low: 98, close: 102 },
  { open: 102, high: 110, low: 101, close: 105 }, // HIGH#1 110 (HH)
  { open: 105, high: 108, low: 102, close: 106 },
  { open: 106, high: 109, low: 104, close: 105 },
  { open: 105, high: 107, low: 101, close: 104 },
  { open: 104, high: 106, low: 100, close: 103 },
  { open: 103, high: 105, low: 99, close: 102 },
  { open: 102, high: 104, low: 94, close: 101 }, // LOW#2 94 (HL)
  { open: 101, high: 103, low: 96, close: 100 },
  { open: 100, high: 102, low: 95, close: 99 },
  { open: 99, high: 100, low: 88, close: 92 }, // 价格跌破 HL（V 型反转）
];

test("HTF 严格 swing 判定 BEARISH（LL+LH），无 price 时不修正", () => {
  assert.equal(computeHtfDirection(DAY_CANDLES_BREAK_LH.slice(0, -1), [], null), "BEARISH");
});

test("HTF: 价格突破最后 LH → BOS 修正为 BULLISH（ETH 08-13 场景）", () => {
  assert.equal(computeHtfDirection(DAY_CANDLES_BREAK_LH, [], 119), "BULLISH");
});

test("HTF 分层：日线收盘确认仍空，盘中突破只作为 1D 临时转多预警", () => {
  // 突破腿尚未作为已收盘日 K 输入；119 仅代表当前盘中价格。
  const ctx = computeHtfContext(DAY_CANDLES_BREAK_LH.slice(0, -1), [], 119);
  assert.equal(ctx.confirmedDirection, "BEARISH");
  assert.equal(ctx.confirmedTimeframe, "1D");
  assert.equal(ctx.provisionalDirection, "BULLISH");
  assert.deepEqual(ctx.provisionalBreak, { direction: "BULLISH", timeframe: "1D", level: 106 });
});

test("HTF 临时突破预警保留0.1%缓冲，过滤贴线抖动", () => {
  const insideBuffer = computeHtfContext(DAY_CANDLES_BREAK_LH.slice(0, -1), [], 106.05);
  const outsideBuffer = computeHtfContext(DAY_CANDLES_BREAK_LH.slice(0, -1), [], 106.2);
  assert.equal(insideBuffer.provisionalBreak, null);
  assert.deepEqual(outsideBuffer.provisionalBreak, { direction: "BULLISH", timeframe: "1D", level: 106 });
});

test("HTF 分层：日线收盘站上关键位后，临时突破升级为已确认方向", () => {
  const ctx = computeHtfContext(DAY_CANDLES_BREAK_LH, [], 119);
  assert.equal(ctx.confirmedDirection, "BULLISH");
  assert.equal(ctx.confirmedTimeframe, "1D");
  assert.equal(ctx.provisionalBreak, null);
});

test("HTF 严格 swing 判定 BULLISH（HH+HL），无 price 时不修正", () => {
  assert.equal(computeHtfDirection(DAY_CANDLES_BREAK_HL.slice(0, -1), [], null), "BULLISH");
});

test("HTF: 价格跌破最后 HL → BOS 修正为 BEARISH", () => {
  assert.equal(computeHtfDirection(DAY_CANDLES_BREAK_HL, [], 92), "BEARISH");
});

test("HTF: price 介于最后高/低点之间 → 不修正（维持原判定）", () => {
  // LL+LH 判定 BEARISH，price 105 在 90~106 之间 → 仍 BEARISH
  assert.equal(computeHtfDirection(DAY_CANDLES_BREAK_LH.slice(0, -1), [], 105), "BEARISH");
});

// ---- Engine 集成 ----

test("V2.0 engine: htfDirection 注入 → scenario + confidence 随结果输出", () => {
  const location = { location: "DISCOUNT", context: "DISCOUNT_VALID", high: 180, low: 100, equilibrium: 140 };
  const pd = { fvg: [{ type: "BULLISH_FVG", direction: "BULLISH", top: 120, bottom: 110 }], ob: [] };
  const r = computeDailyBias({
    structure: { direction: "BULLISH", protectedLow: 100, protectedLowInfo: { invalidationType: "STRUCTURE_PROTECTED_LOW", source: "HL_BEFORE_DISPLACEMENT" } },
    liquidity: { buySide: [{ type: "PWH", price: 200 }], sellSide: [], primaryBuyDraw: { type: "PWH", price: 200 }, primarySellDraw: null },
    location,
    price: 120,
    pdArray: pd,
    htfDirection: "BULLISH",
  });
  assert.equal(r.scenario.state, "TREND_CONTINUATION");
  assert.equal(r.scenario.label, "BULLISH_CONTINUATION");
  assert.equal(r.confidence.level, "MEDIUM");
  assert.equal(r.confidence.score, 55); // V2.3 数据驱动：25+15+25+10−10(VALID)−10(Wide range 66.7%)=55
  assert.ok(r.confidence.factors.some((f) => f.name === "Wide range"));
  assert.equal(r.executionState, "READY"); // DISCOUNT_VALID
});
