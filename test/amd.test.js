/**
 * AMD（Accumulation / Manipulation / Distribution）阶段判定单元测试
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAmdStage } from "../indicators/amd.js";

const NOW = 1000000;
const WINDOW = 24 * 60 * 60 * 1000;
// 5m K 线工厂：交替 100/100.5 折返（ER ≈ 0.02，横盘）；单边 100→100.47（ER = 1）
const mkM5 = (closes, baseTime = NOW - 100 * 300000) =>
  closes.map((c, i) => ({ time: baseTime + i * 300000, closeTime: baseTime + (i + 1) * 300000, close: c, high: c, low: c }));
const CHOP = mkM5(Array.from({ length: 48 }, (_, i) => (i % 2 ? 100.5 : 100)));
const TREND = mkM5(Array.from({ length: 48 }, (_, i) => 100 + (i / 47) * 0.47));
const RANGE = { high: 101, low: 99, rangeType: "IMPULSE_BULLISH" };

test("最近窗口内有位移 → DISTRIBUTION（方向 = 位移方向）", () => {
  const r = computeAmdStage({
    displacement: { time: NOW - 1000, direction: "UP", ratio: 2.4 },
    sweep: null,
    structure: { direction: "BULLISH" },
    windowMs: WINDOW,
    now: NOW,
  });
  assert.equal(r.stage, "DISTRIBUTION");
  assert.equal(r.direction, "BULLISH");
  assert.match(r.reason, /2\.4/);
});

test("最近窗口内仅扫损（BSL 上方收回）→ MANIPULATION（诱多 → 看跌）", () => {
  const r = computeAmdStage({
    displacement: null,
    sweep: { time: NOW - 2000, side: "BSL" },
    structure: { direction: "BULLISH" },
    windowMs: WINDOW,
    now: NOW,
  });
  assert.equal(r.stage, "MANIPULATION");
  assert.equal(r.direction, "BEARISH");
  assert.match(r.reason, /上方/);
});

test("扫损 SSL（下方收回）→ MANIPULATION（诱空 → 看涨）", () => {
  const r = computeAmdStage({
    displacement: null,
    sweep: { time: NOW - 2000, side: "SSL" },
    structure: { direction: "BEARISH" },
    windowMs: WINDOW,
    now: NOW,
  });
  assert.equal(r.stage, "MANIPULATION");
  assert.equal(r.direction, "BULLISH");
  assert.match(r.reason, /下方/);
});

test("位移与扫损都发生：位移更新 → DISTRIBUTION 胜出", () => {
  const r = computeAmdStage({
    displacement: { time: NOW - 1000, direction: "DOWN", ratio: 1.8 },
    sweep: { time: NOW - 5000, side: "SSL" },
    structure: { direction: "BEARISH" },
    windowMs: WINDOW,
    now: NOW,
  });
  assert.equal(r.stage, "DISTRIBUTION");
  assert.equal(r.direction, "BEARISH");
});

test("扫损更新于位移之后 → MANIPULATION 胜出（刚扫完、分发未确认）", () => {
  const r = computeAmdStage({
    displacement: { time: NOW - 5000, direction: "UP", ratio: 2 },
    sweep: { time: NOW - 1000, side: "BSL" },
    structure: { direction: "BULLISH" },
    windowMs: WINDOW,
    now: NOW,
  });
  assert.equal(r.stage, "MANIPULATION");
});

test("无操纵/分发证据 + 横盘（ER<0.25）+ 现价在区间内 + 无推进 → ACCUMULATION", () => {
  const r = computeAmdStage({
    displacement: null,
    sweep: null,
    structure: { direction: "BULLISH" },
    range: RANGE,
    mssEvents: [],
    m5: CHOP,
    price: 100.2,
    windowMs: WINDOW,
    now: NOW,
  });
  assert.equal(r.stage, "ACCUMULATION");
  assert.equal(r.direction, "BULLISH");
  assert.match(r.reason, /区间震荡 ER/);
  assert.equal(r.evidenceTime, null);
});

test("证据过旧（超出窗口）+ 横盘在区间内 → ACCUMULATION", () => {
  const r = computeAmdStage({
    displacement: { time: NOW - WINDOW - 1000, direction: "UP", ratio: 2 },
    sweep: null,
    structure: { direction: "NEUTRAL" },
    range: RANGE,
    mssEvents: [],
    m5: CHOP,
    price: 100.2,
    windowMs: WINDOW,
    now: NOW,
  });
  assert.equal(r.stage, "ACCUMULATION");
  assert.equal(r.direction, "NEUTRAL");
});

test("无操纵/分发证据 + 单边推进（ER=1）→ UNSET（不误标积累）", () => {
  const r = computeAmdStage({
    displacement: null,
    sweep: null,
    structure: { direction: "BULLISH" },
    range: RANGE,
    mssEvents: [],
    m5: TREND,
    price: 100.2,
    windowMs: WINDOW,
    now: NOW,
  });
  assert.equal(r.stage, "UNSET");
});

test("横盘但现价冲出区间 → UNSET", () => {
  const r = computeAmdStage({
    displacement: null,
    sweep: null,
    structure: { direction: "BULLISH" },
    range: RANGE,
    mssEvents: [],
    m5: CHOP,
    price: 102,
    windowMs: WINDOW,
    now: NOW,
  });
  assert.equal(r.stage, "UNSET");
});

test("横盘在区间内但 4h 内有 5m MSS 推进 → UNSET（有结构推进不算积累）", () => {
  const r = computeAmdStage({
    displacement: null,
    sweep: null,
    structure: { direction: "BULLISH" },
    range: RANGE,
    mssEvents: [{ time: NOW - 1000, type: "MSS" }],
    m5: CHOP,
    price: 100.2,
    windowMs: WINDOW,
    now: NOW,
  });
  assert.equal(r.stage, "UNSET");
});

test("无区间/数据不足（m5 为空）→ UNSET（无积累证据）", () => {
  const r = computeAmdStage({
    displacement: null,
    sweep: null,
    structure: { direction: "BULLISH" },
    range: null,
    mssEvents: [],
    m5: [],
    price: 100.2,
    windowMs: WINDOW,
    now: NOW,
  });
  assert.equal(r.stage, "UNSET");
});
