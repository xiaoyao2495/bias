/**
 * scanner.test.js — V2.2 Historical Bias Scanner
 *
 * 覆盖两个核心模块：
 *   evaluator.js   — 未来窗口 WIN/LOSS/NEUTRAL/SKIP 逐根判定（先到先判）
 *   statistics.js  — 分组统计 accuracy 口径（WIN/(WIN+LOSS)）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateOutcome } from "../scanner/evaluator.js";
import { computeStatistics } from "../scanner/statistics.js";
import { computeQuality, formatQualityReport } from "../scanner/quality.js";

// --- 构造未来 K 线工具 ---
const bar = (i, open, high, low, close) => ({ time: i * 4 * 3600_000, open, high, low, close });

test("evaluator: BULLISH 先触及 Draw → WIN（即使后来破位也不算 LOSS）", () => {
  const candles = [bar(1, 100, 112, 99, 110), bar(2, 110, 120, 105, 115)]; // 第一根先到 draw 110
  const r = evaluateOutcome({ bias: "BULLISH", entry: 100, invalidation: 90, drawPrice: 110, futureCandles: candles, windows: [2] });
  assert.equal(r.futures[2].outcome, "WIN");
  assert.equal(r.futures[2].hitDraw, true);
});

test("evaluator: BULLISH 先破保护位 → LOSS", () => {
  const candles = [bar(1, 100, 101, 89, 90), bar(2, 90, 95, 85, 86)]; // 第一根先到 invalidation 90
  const r = evaluateOutcome({ bias: "BULLISH", entry: 100, invalidation: 90, drawPrice: 115, futureCandles: candles, windows: [2] });
  assert.equal(r.futures[2].outcome, "LOSS");
  assert.equal(r.futures[2].hitInvalidation, true);
});

test("evaluator: 先到先判 — 同一根内先触及目标判定 WIN（目标线取 Draw 与 +targetPct 更近者）", () => {
  // entry=100, draw=112, targetPct=5% → 目标线 = min(112, 105) = 105；invalidation=95
  // 第一根 high=105 先到目标（未破 95），第二根才破位 → WIN
  const candles = [bar(1, 100, 105, 96, 104), bar(2, 104, 106, 94, 95)];
  const r = evaluateOutcome({ bias: "BULLISH", entry: 100, invalidation: 95, drawPrice: 112, targetPct: 0.05, futureCandles: candles, windows: [2] });
  assert.equal(r.futures[2].outcome, "WIN");
  assert.equal(r.futures[2].hitDraw, false); // 105 < 112，未真正触及 Draw
});

test("evaluator: 同一根内先破位后碰目标 → LOSS（逐根先到先判）", () => {
  // 第一根 low=94 先破 invalidation 95（此时未到目标 105）→ LOSS
  const candles = [bar(1, 100, 94, 94, 94), bar(2, 94, 106, 93, 105)];
  const r = evaluateOutcome({ bias: "BULLISH", entry: 100, invalidation: 95, drawPrice: 104, targetPct: 0.05, futureCandles: candles, windows: [2] });
  assert.equal(r.futures[2].outcome, "LOSS");
});

test("evaluator: 窗口内两者都未触及 → NEUTRAL", () => {
  const candles = [bar(1, 100, 102, 98, 101), bar(2, 101, 103, 97, 99)];
  const r = evaluateOutcome({ bias: "BULLISH", entry: 100, invalidation: 90, drawPrice: 115, futureCandles: candles, windows: [2] });
  assert.equal(r.futures[2].outcome, "NEUTRAL");
});

test("evaluator: BEARISH 对称 — 先触及下方目标 → WIN", () => {
  const candles = [bar(1, 100, 101, 90, 91)];
  const r = evaluateOutcome({ bias: "BEARISH", entry: 100, invalidation: 108, drawPrice: 90, futureCandles: candles, windows: [1] });
  assert.equal(r.futures[1].outcome, "WIN");
});

test("evaluator: SKIP — NEUTRAL / 无保护位 / 无未来 K 线", () => {
  const c = [bar(1, 100, 101, 99, 100)];
  assert.equal(evaluateOutcome({ bias: "NEUTRAL", entry: 100, invalidation: 90, futureCandles: c }).futures[7].outcome, "SKIP");
  assert.equal(evaluateOutcome({ bias: "BULLISH", entry: 100, invalidation: null, futureCandles: c }).futures[7].outcome, "SKIP");
  assert.equal(evaluateOutcome({ bias: "BULLISH", entry: 100, invalidation: 90, futureCandles: [] }).futures[7].outcome, "SKIP");
});

test("evaluator: 多窗口独立评估 + maxR（最佳浮盈/风险）", () => {
  const candles = [bar(1, 100, 104, 98, 102), bar(2, 102, 110, 100, 108)];
  const r = evaluateOutcome({ bias: "BULLISH", entry: 100, invalidation: 96, drawPrice: null, targetPct: 0.05, futureCandles: candles, windows: [7, 14] });
  assert.equal(r.futures[7].outcome, "WIN"); // 无 draw 时目标线 105，第二根 high 110 触及
  assert.equal(r.futures[14].outcome, "WIN"); // 超出部分无 K 线，与 7 根窗口结果一致
  assert.equal(r.maxR, 2.5); // (110-100)/(100-96)
});

test("evaluator: 无 draw 时用 targetPct 幅度判定", () => {
  const candles = [bar(1, 100, 106, 99, 105)]; // high 106 >= 105 → WIN
  const r = evaluateOutcome({ bias: "BULLISH", entry: 100, invalidation: 95, drawPrice: null, targetPct: 0.05, futureCandles: candles, windows: [1] });
  assert.equal(r.futures[1].outcome, "WIN");
  assert.equal(r.maxR, 6 / 5); // (106-100)/(100-95)
});

// --- V2.4 盈亏质量 ---

test("evaluator: planR = |Draw−Entry|/Risk（理论盈亏比）", () => {
  // entry=100, invalidation=90（risk=10）, draw=112 → planR=(112-100)/10=1.2
  const r = evaluateOutcome({ bias: "BULLISH", entry: 100, invalidation: 90, drawPrice: 112, futureCandles: [bar(1, 100, 101, 99, 100)], windows: [1] });
  assert.equal(r.planR, 1.2);
});

test("evaluator: WIN 触及 Draw → r = planR；只到 targetPct → r = targetPct/riskPct；LOSS → r = −1", () => {
  // 目标线 min(112, 105)=105；risk=10, riskPct=0.1
  const hitDraw = evaluateOutcome({ bias: "BULLISH", entry: 100, invalidation: 90, drawPrice: 112, futureCandles: [bar(1, 100, 113, 99, 112)], windows: [1] });
  assert.equal(hitDraw.futures[1].outcome, "WIN");
  assert.equal(hitDraw.futures[1].hitDraw, true);
  assert.equal(hitDraw.futures[1].r, 1.2); // planR

  const hitPct = evaluateOutcome({ bias: "BULLISH", entry: 100, invalidation: 90, drawPrice: 112, futureCandles: [bar(1, 100, 106, 99, 105)], windows: [1] });
  assert.equal(hitPct.futures[1].outcome, "WIN");
  assert.equal(hitPct.futures[1].hitDraw, false);
  assert.equal(hitPct.futures[1].r, 0.05 / 0.1); // targetPct/riskPct = 0.5

  const loss = evaluateOutcome({ bias: "BULLISH", entry: 100, invalidation: 90, drawPrice: 112, futureCandles: [bar(1, 100, 101, 89, 90)], windows: [1] });
  assert.equal(loss.futures[1].outcome, "LOSS");
  assert.equal(loss.futures[1].r, -1);
});

test("evaluator: NEUTRAL → r = 收盘相对风险", () => {
  const r = evaluateOutcome({ bias: "BULLISH", entry: 100, invalidation: 90, drawPrice: 112, futureCandles: [bar(1, 100, 102, 98, 99)], windows: [1] });
  assert.equal(r.futures[1].outcome, "NEUTRAL");
  assert.equal(r.futures[1].r, (99 - 100) / 10); // -0.1
});

test("evaluator: MAE/MFE（相对 Entry 的 %）", () => {
  // 两根 K：high 113 / low 95 → BULLISH mfe=(113-100)/100=0.13, mae=(100-95)/100=0.05
  const r = evaluateOutcome({ bias: "BULLISH", entry: 100, invalidation: 90, drawPrice: 115, futureCandles: [bar(1, 100, 106, 95, 100), bar(2, 100, 113, 99, 110)], windows: [7] });
  assert.equal(r.maePct, 0.05);
  assert.equal(r.mfePct, 0.13);
});

// --- V2.4 quality.js ---

const qSample = (conf, outcome30, r, planR, mae, mfe) => ({
  bias: "BULLISH",
  confidence: conf,
  planR,
  maePct: mae,
  mfePct: mfe,
  futures: {
    "30": { outcome: outcome30, r, high: 0, low: 0, close: 0 },
    "7": { outcome: "NEUTRAL", r: 0, high: 0, low: 0, close: 0 },
  },
});

test("quality: 按 Confidence 分组输出 Direction Accuracy / R / MAE / MFE", () => {
  const samples = [
    qSample("HIGH", "WIN", 2, 2, 0.005, 0.06),
    qSample("HIGH", "WIN", 3, 2, 0.01, 0.08),
    qSample("HIGH", "LOSS", -1, 2, 0.02, 0.03),
    qSample("MEDIUM", "WIN", 1, 1, 0.01, 0.04),
    qSample("LOW", "LOSS", -1, 0.5, 0.03, 0.01),
  ];
  const q = computeQuality(samples, 30);
  assert.equal(q.groups.HIGH.n, 3);
  assert.equal(q.groups.HIGH.accuracy, 66.7); // 2W/3
  assert.equal(q.groups.HIGH.avgR, 1.33); // (2+3−1)/3 四舍五入到 2 位
  assert.equal(q.groups.HIGH.medianR, 2); // [-1,2,3] 中位数
  assert.equal(q.groups.HIGH.planR, 2);
  assert.equal(q.groups.HIGH.medianMaePct, 0.01); // [0.005,0.01,0.02]
  assert.equal(q.groups.HIGH.medianMfePct, 0.06); // [0.03,0.06,0.08]
  assert.equal(q.groups.MEDIUM.accuracy, 100);
  assert.equal(q.groups.LOW.accuracy, 0);
  // overall：4 个有结论（3W+1L… 实际 HIGH 3 + MEDIUM 1 + LOW 1 = 5 全部有结论）
  assert.equal(q.overall.n, 5);
});

test("quality: 报告文本包含关键字段", () => {
  const samples = [qSample("HIGH", "WIN", 2, 2, 0.005, 0.06)];
  const q = computeQuality(samples, 30);
  const txt = formatQualityReport({ symbol: "TEST", meta: {}, quality: q });
  assert.match(txt, /HIGH/);
  assert.match(txt, /acc/);
  assert.match(txt, /avgR/);
  assert.match(txt, /medMAE/);
});

// --- statistics ---
const mkSample = (bias, confidence, scenario, execution, outcome30) => ({
  bias,
  confidence,
  scenario,
  execution,
  futures: {
    "7": { outcome: outcome30, high: 0, low: 0, close: 0 },
    "30": { outcome: outcome30, high: 0, low: 0, close: 0 },
  },
});

test("statistics: accuracy = WIN/(WIN+LOSS)，NEUTRAL/SKIP 不计入分母", () => {
  const samples = [
    mkSample("BULLISH", "HIGH", "BULLISH_CONTINUATION", "READY", "WIN"),
    mkSample("BULLISH", "HIGH", "BULLISH_CONTINUATION", "READY", "WIN"),
    mkSample("BULLISH", "HIGH", "BULLISH_CONTINUATION", "READY", "LOSS"),
    mkSample("BULLISH", "HIGH", "BULLISH_CONTINUATION", "READY", "NEUTRAL"),
    mkSample("NEUTRAL", "LOW", "RANGE", "NONE", "SKIP"),
  ];
  const s = computeStatistics(samples, 30);
  assert.equal(s.distribution.total, 5);
  assert.equal(s.distribution.BULLISH, 4);
  assert.equal(s.distribution.NEUTRAL, 1);
  // BULLISH 窗口30：2W+1L+1N → acc = 2/3 = 66.7%
  assert.equal(s.byBias.BULLISH.win, 2);
  assert.equal(s.byBias.BULLISH.loss, 1);
  assert.equal(s.byBias.BULLISH.accuracy, 66.7);
  assert.equal(s.byBias.BULLISH.neutral, 1);
});

test("statistics: byConfidence 按 bias×confidence 分组", () => {
  const samples = [
    mkSample("BULLISH", "HIGH", "BULLISH_CONTINUATION", "READY", "WIN"),
    mkSample("BULLISH", "MEDIUM", "BULLISH_CONTINUATION", "WAIT", "WIN"),
    mkSample("BEARISH", "HIGH", "BEARISH_REVERSAL_ATTEMPT", "READY", "LOSS"),
  ];
  const s = computeStatistics(samples, 30);
  assert.equal(s.byConfidence.BULLISH.HIGH.win, 1);
  assert.equal(s.byConfidence.BULLISH.MEDIUM.win, 1);
  assert.equal(s.byConfidence.BEARISH.HIGH.loss, 1);
  assert.equal(s.byConfidence.BEARISH.HIGH.accuracy, 0);
});

test("statistics: byScenario 按 label 归类 CONTINUATION / REVERSAL_ATTEMPT", () => {
  const samples = [
    mkSample("BULLISH", "HIGH", "BULLISH_CONTINUATION", "READY", "WIN"),
    mkSample("BULLISH", "HIGH", "BULLISH_REVERSAL_ATTEMPT", "READY", "LOSS"),
    mkSample("BULLISH", "HIGH", "BULLISH_REVERSAL_ATTEMPT", "READY", "WIN"),
    mkSample("BEARISH", "HIGH", "BEARISH_CONTINUATION", "READY", "WIN"),
  ];
  const s = computeStatistics(samples, 30);
  assert.equal(s.byScenario.BULLISH.CONTINUATION.win, 1);
  assert.equal(s.byScenario.BULLISH.REVERSAL_ATTEMPT.win, 1);
  assert.equal(s.byScenario.BULLISH.REVERSAL_ATTEMPT.loss, 1);
  assert.equal(s.byScenario.BEARISH.CONTINUATION.win, 1);
});

test("statistics: byExecution 合并两个方向，byWindow 覆盖全部窗口", () => {
  const samples = [
    mkSample("BULLISH", "HIGH", "BULLISH_CONTINUATION", "READY", "WIN"),
    mkSample("BEARISH", "HIGH", "BEARISH_CONTINUATION", "WAIT", "LOSS"),
  ];
  const s = computeStatistics(samples, 30);
  assert.equal(s.byExecution.READY.n, 1);
  assert.equal(s.byExecution.WAIT.n, 1);
  assert.deepEqual(Object.keys(s.byWindow).sort(), ["30", "7"]);
  assert.equal(s.byWindow["7"].win, 1); // 有向样本 2 个，1W1L → acc 50%
  assert.equal(s.byWindow["7"].accuracy, 50);
});
