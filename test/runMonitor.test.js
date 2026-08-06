/**
 * runMonitor.test.js — 监控消息构建（纯函数层）
 *
 * 覆盖 runMonitor 的核心展示逻辑（多次返工、最易出错的字段布局）：
 *   buildChanged / buildSweep / buildCloseReport / buildOverview
 * 网络、文件状态、钉钉推送等副作用不在此测（依赖 dry-run 集成验证）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChanged, buildSweep, buildCloseReport, buildOverview } from "../scripts/runMonitor.js";

const baseCur = { bias: "NEUTRAL", confidence: "LOW", decision: "WAIT", quality: "LOW", planR: null, scenario: "RANGE" };
const basePrev = { bias: "BULLISH", confidence: "LOW", decision: "WAIT", quality: "LOW", planR: null, scenario: "RANGE" };

test("buildChanged: bias 翻转 + 结构失效 MSS（C1 schema）— ⚠️ 头、旧→新、MSS 结构行、价格", () => {
  const msg = buildChanged({
    symbol: "BTCUSDT", price: 108, reason: [],
    changes: ["bias"], prev: basePrev, cur: baseCur,
    confidenceScore: 0, structureStatus: "INVALIDATED",
    invalidation: { type: "BREAK_PROTECTED_LOW", price: 108.5 },
    mss: { type: "MSS", direction: "DOWN", level: 108.5, price: 108, confirmed: true, structureFrom: "BULLISH", structureTo: "NEUTRAL", time: "08/05 20:00" },
  });
  assert.match(msg, /\*\*⚠️ BTCUSDT 4H Bias 变化\*\*/);
  assert.match(msg, /🟢 BULLISH → ⚪ NEUTRAL/);
  assert.match(msg, /\*\*结构事件: MSS\*\*（向下跌破 108.5，原 BULLISH 结构失效）/);
  assert.match(msg, /触发: 08\/05 20:00 · 价格 108/);
  assert.match(msg, /操作: WAIT/);
  assert.match(msg, /价格: 108/);
});

test("buildChanged: 非 bias 变化 — ℹ️ 头、信心度/操作 旧→新、原因、机会质量", () => {
  const msg = buildChanged({
    symbol: "ETHUSDT", price: 3500, reason: "信心度提升：HTF 对齐 + 折价区",
    changes: ["confidence", "decision"],
    prev: { ...basePrev, bias: "BULLISH" },
    cur: { bias: "BULLISH", confidence: "MEDIUM", decision: "WATCH_FOR_ENTRY", quality: "MEDIUM", planR: 1.2, scenario: "TREND_CONTINUATION" },
    confidenceScore: 52, structureStatus: "VALID", invalidation: null, mss: null,
  });
  assert.match(msg, /\*\*ℹ️ ETHUSDT 4H Bias 更新\*\*/);
  assert.match(msg, /信心度: LOW → MEDIUM 52/);
  assert.match(msg, /操作: WAIT → WATCH_FOR_ENTRY/);
  assert.match(msg, /机会质量: MEDIUM \(planR 1.20\)/);
  assert.match(msg, /原因: 信心度提升/);
  assert.match(msg, /价格: 3500/);
});

test("buildChanged: Scenario 值 + 原因英译中（ETHUSDT 08-06 通知场景）", () => {
  const msg = buildChanged({
    symbol: "ETHUSDT", price: 1910.86, reason: "Enough upside room with acceptable direction probability",
    changes: ["confidence", "decision"],
    prev: { ...basePrev, bias: "BULLISH" },
    cur: { bias: "BULLISH", confidence: "MEDIUM", decision: "WATCH", quality: "HIGH", planR: 1.26, scenario: "BULLISH_REVERSAL_ATTEMPT", session: { start: 20, end: 24, ratio: 28.6 } },
    confidenceScore: 45, structureStatus: "VALID", invalidation: null, mss: null,
  });
  assert.match(msg, /Scenario: 多头反转尝试/);
  assert.match(msg, /原因: 方向概率可接受且上方空间充足/);
  assert.match(msg, /Session: 活跃窗口 20:00-24:00（占比 28.6%）/);
});

test("buildSweep: SSL 已收盘确认 — 侧/位/价/回收/背景字段齐全", () => {
  const msg = buildSweep({
    symbol: "SPCXUSDT", price: 111.56,
    sweep: { side: "SSL", type: "EQL", level: 111.01, sweptPrice: 110.67, close: 111.56, time: 111111, key: "k", realtime: false, closedTime: 111222 },
    cur: baseCur, confidenceScore: 0, mss5m: null,
  });
  assert.match(msg, /\*\*⚡ SPCXUSDT 流动性扫损（已确认）\*\*/);
  assert.match(msg, /下方卖方流动性（SSL）被扫：跌破 等低点 111.01（低 110.67）后收回，收 111.56/);
  assert.match(msg, /市场背景:/);
  assert.match(msg, /Bias: ⚪ NEUTRAL/);
  assert.match(msg, /Scenario: 区间/);
  assert.match(msg, /信心度: LOW 0/);
  assert.match(msg, /操作: WAIT/);
});

test("buildSweep: 带 5m 结构事件标注（C3）— 扫损消息展示 5m MSS/BOS", () => {
  const msg = buildSweep({
    symbol: "SPCXUSDT", price: 111.56,
    sweep: { side: "SSL", type: "EQL", level: 111.01, sweptPrice: 110.67, close: 111.56, time: 111111, key: "k", realtime: false, closedTime: 111222 },
    cur: baseCur, confidenceScore: 0,
    mss5m: { direction: "BULLISH", lastEvent: { type: "MSS", direction: "UP", level: 111.22, confirmed: true } },
  });
  assert.match(msg, /5m 结构: MSS UP @ 111.22（已确认）/);
});

test("buildSweep: BSL 实时 — 刺破上方流动性且现价收回", () => {
  const msg = buildSweep({
    symbol: "BTCUSDT", price: 104,
    sweep: { side: "BSL", type: "PDH", level: 105, sweptPrice: 106, close: 104, time: 1, key: "k", realtime: true },
    cur: baseCur, confidenceScore: 0, mss5m: null,
  });
  assert.match(msg, /\*\*⚡ BTCUSDT 流动性扫损（实时）\*\*/);
  assert.match(msg, /上方买方流动性（BSL）被扫：刺破 昨日高点 105（高 106）后收回，收 104/);
});

test("buildCloseReport: 收上/收下幅度 + 位移标注（含 BOS/FVG 证据）", () => {
  const msg = buildCloseReport([
    { symbol: "BTCUSDT", last4h: { open: 100, close: 101.2 }, displacement: { direction: "UP", ratio: 2, structureBreak: { type: "BOS", direction: "UP", level: 101.5 }, fvg: { top: 101.5, bottom: 99.9 } }, cur: { bias: "BULLISH", confidence: "MEDIUM" }, confidenceScore: 52 },
    { symbol: "ETHUSDT", last4h: { open: 100, close: 99.5 }, displacement: null, cur: { bias: "BEARISH", confidence: "LOW" }, confidenceScore: 10 },
  ]);
  assert.match(msg, /\*\*4H 收盘报告\*\*/);
  assert.match(msg, /本根 4H 收盘/); // 标题含 收线 视角
  assert.match(msg, /\*\*BTCUSDT\*\* 收上 \+1.20% · 🟢 BULLISH · MEDIUM 52 · 位移↑2.0x（BOS 101.5，FVG 99.9-101.5）/);
  assert.match(msg, /\*\*ETHUSDT\*\* 收下 -0.50% · 🔴 BEARISH · LOW 10/);
});

test("buildOverview: 首轮全览字段布局（Scenario · 信心度 · 机会质量 · 操作）", () => {
  const msg = buildOverview([
    { symbol: "BTCUSDT", cur: { bias: "BULLISH", scenario: "BULLISH_CONTINUATION", confidence: "MEDIUM", quality: "MEDIUM", planR: 1.2, decision: "WATCH_FOR_ENTRY" }, confidenceScore: 52 },
  ]);
  assert.match(msg, /\*\*4H Bias Monitor\*\*/);
  assert.match(msg, /\*\*BTCUSDT\*\* 🟢 BULLISH/);
  assert.match(msg, /Scenario: 多头延续 · 信心度: MEDIUM 52 · 机会质量: MEDIUM \(1.20\) · 操作: WATCH_FOR_ENTRY/);
});

test("buildChanged: OB BREAKER → 显示辅助行（仅有关注价值时）", () => {
  const msg = buildChanged({
    symbol: "ETHUSDT", price: 1910.86, reason: [],
    changes: ["confidence"],
    prev: { ...basePrev, bias: "BULLISH" },
    cur: {
      bias: "BULLISH", confidence: "MEDIUM", decision: "WATCH", quality: "HIGH", planR: 1.26, scenario: "BULLISH_REVERSAL_ATTEMPT",
      ob: { type: "BULLISH_OB", kind: "BREAKER", state: "USED", high: 101.5, low: 98, status: "OPEN", location: "DISCOUNT" },
    },
    confidenceScore: 45, structureStatus: "VALID", invalidation: null, mss: null,
  });
  assert.match(msg, /最近OB: 多头OB（破位反包·已回踩·折扣区）/);
});

test("buildChanged: OB STANDARD·USED → 不显示辅助行（避免噪音）", () => {
  const msg = buildChanged({
    symbol: "ETHUSDT", price: 1910.86, reason: [],
    changes: ["confidence"],
    prev: { ...basePrev, bias: "BULLISH" },
    cur: {
      bias: "BULLISH", confidence: "MEDIUM", decision: "WATCH", quality: "HIGH", planR: 1.26, scenario: "BULLISH_REVERSAL_ATTEMPT",
      ob: { type: "BULLISH_OB", kind: "STANDARD", state: "USED", high: 101.5, low: 98, status: "OPEN", location: "DISCOUNT" },
    },
    confidenceScore: 45, structureStatus: "VALID", invalidation: null, mss: null,
  });
  assert.ok(!msg.includes("最近OB"));
});
