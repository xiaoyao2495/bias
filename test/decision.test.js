/**
 * decision.test.js — V2.5 Bias Decision Layer
 *
 * 覆盖 buildDecision：
 *   Opportunity = Confidence × Space（planR 归一化，两维度都要好）
 *   Tradeability / Decision / Reason 规则（方向不可信 > 空间不足 > 等回撤 > 值得找入场）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDecision } from "../engine/decision.js";

const D = (bias, confidence, price, invalidation, drawPrice) =>
  buildDecision({
    bias,
    confidence,
    draw: drawPrice == null ? null : { primary: { type: "PDH", price: drawPrice } },
    price,
    invalidation,
  });

test("NEUTRAL → WAIT / tradeability LOW / opportunity 0", () => {
  const d = D("NEUTRAL", { score: 0, level: "LOW" }, 100, 95, 110);
  assert.equal(d.decision, "WAIT");
  assert.equal(d.tradeability, "LOW");
  assert.equal(d.opportunity, 0);
  assert.equal(d.planR, null);
});

test("HIGH(90) + planR 0.34 → NO_TRADE（方向对但空间不足）", () => {
  // price=100, invalidation=95（risk=5）, draw=101.7 → planR=1.7/5=0.34
  const d = D("BULLISH", { score: 90, level: "HIGH" }, 100, 95, 101.7);
  assert.ok(Math.abs(d.planR - 0.34) < 1e-9);
  assert.equal(d.decision, "NO_TRADE");
  assert.equal(d.tradeability, "LOW");
  assert.equal(d.opportunity, 15); // 90 × min(1, 0.34/2) = 15.3 → 15
  assert.match(d.reason, /reward insufficient/);
});

test("MEDIUM(55) + planR 1.5 → WATCH_FOR_ENTRY（空间够方向可接受）", () => {
  // price=100, invalidation=98（risk=2）, draw=103 → planR=3/2=1.5
  const d = D("BULLISH", { score: 55, level: "MEDIUM" }, 100, 98, 103);
  assert.equal(d.planR, 1.5);
  assert.equal(d.decision, "WATCH_FOR_ENTRY");
  assert.equal(d.tradeability, "MEDIUM");
  assert.equal(d.opportunity, 41); // 55 × 0.75 = 41.25 → 41
  assert.match(d.reason, /Enough upside room/);
});

test("LOW(20) + planR 1.5 → NO_TRADE（方向不可信优先于空间）", () => {
  const d = D("BULLISH", { score: 20, level: "LOW" }, 100, 98, 103);
  assert.equal(d.decision, "NO_TRADE");
  assert.match(d.reason, /probability too low/);
});

test("MEDIUM(60) + planR 2.5 → WATCH_FOR_ENTRY / tradeability HIGH", () => {
  // price=100, invalidation=99（risk=1）, draw=102.5 → planR=2.5
  const d = D("BULLISH", { score: 60, level: "MEDIUM" }, 100, 99, 102.5);
  assert.equal(d.planR, 2.5);
  assert.equal(d.opportunity, 60); // 60 × min(1, 2.5/2)=1 → 60
  assert.equal(d.tradeability, "HIGH");
  assert.equal(d.decision, "WATCH_FOR_ENTRY");
});

test("planR 0.5~1 → WAIT_FOR_RETRACEMENT（空间有限等回撤放大 R）", () => {
  // price=100, invalidation=98（risk=2）, draw=101.4 → planR=1.4/2=0.7
  const d = D("BULLISH", { score: 60, level: "MEDIUM" }, 100, 98, 101.4);
  assert.ok(Math.abs(d.planR - 0.7) < 1e-9);
  assert.equal(d.decision, "WAIT_FOR_RETRACEMENT");
  assert.equal(d.tradeability, "LOW"); // opportunity = 60×0.35 = 21
  assert.match(d.reason, /wait for retracement/);
});

test("无 draw（planR null）→ NO_TRADE（无 reward 估计）", () => {
  const d = buildDecision({ bias: "BULLISH", confidence: { score: 90, level: "HIGH" }, draw: null, price: 100, invalidation: 95 });
  assert.equal(d.planR, null);
  assert.equal(d.decision, "NO_TRADE");
  assert.equal(d.opportunity, 0);
});

test("engine 传入 invalidation 为对象 {type, price} → 正确提取价格", () => {
  const d = buildDecision({
    bias: "BULLISH",
    confidence: { score: 95, level: "HIGH" },
    draw: { primary: { type: "PWH", price: 125708.42 } },
    price: 123482.31,
    invalidation: { type: "BREAK_PROTECTED_LOW", price: 121510 },
  });
  assert.ok(d.planR != null); // (125708.42−123482.31)/(123482.31−121510) ≈ 1.13
  assert.ok(Math.abs(d.planR - 1.129) < 1e-2);
  assert.equal(d.decision, "WATCH_FOR_ENTRY");
});
