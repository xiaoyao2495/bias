/**
 * pdArray 与 dealingRange 单元测试：FVG、Order Block、Premium/Discount
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findFvgs, findOrderBlocks, annotatePDArray, rankPDArray } from "../indicators/pdArray.js";
import { computeDealingRange } from "../indicators/dealingRange.js";

function candle(o, h, l, c, i) {
  return { time: i, open: o, high: h, low: l, close: c, closeTime: 0 };
}

test("FVG: Bullish（K1.high < K3.low）", () => {
  const candles = [
    candle(99, 100, 98, 99, 0), // K1
    candle(108, 110, 105, 109, 1), // K2
    candle(110, 112, 108, 111, 2), // K3
  ];
  const fvgs = findFvgs(candles);
  assert.equal(fvgs.length, 1);
  assert.equal(fvgs[0].type, "BULLISH_FVG");
  assert.equal(fvgs[0].top, 108); // K3.low
  assert.equal(fvgs[0].bottom, 100); // K1.high
});

test("FVG: Bearish（K1.low > K3.high）", () => {
  const candles = [
    candle(108, 110, 105, 109, 0), // K1
    candle(100, 104, 99, 101, 1), // K2
    candle(99, 100, 97, 98, 2), // K3
  ];
  const fvgs = findFvgs(candles);
  assert.equal(fvgs.length, 1);
  assert.equal(fvgs[0].type, "BEARISH_FVG");
  assert.equal(fvgs[0].top, 105); // K1.low
  assert.equal(fvgs[0].bottom, 100); // K3.high
});

test("Order Block: Bullish（阴线后强阳突破）", () => {
  const candles = [
    candle(102, 103, 98, 99, 0), // 阴线
    candle(100, 107, 99, 106, 1), // 阳线突破 prev.high
  ];
  const obs = findOrderBlocks(candles);
  assert.equal(obs.length, 1);
  assert.equal(obs[0].type, "BULLISH_OB");
  assert.equal(obs[0].high, 103);
  assert.equal(obs[0].low, 98);
  assert.equal(obs[0].experimental, true); // V1.1: OB 标记 experimental
});

test("Order Block: Bearish（阳线后强阴跌破）", () => {
  const candles = [
    candle(99, 104, 98, 103, 0), // 阳线
    candle(102, 103, 95, 96, 1), // 阴线跌破 prev.low
  ];
  const obs = findOrderBlocks(candles);
  assert.equal(obs.length, 1);
  assert.equal(obs[0].type, "BEARISH_OB");
  assert.equal(obs[0].high, 104);
  assert.equal(obs[0].low, 98);
});

test("Dealing Range: price 低于中线 → DISCOUNT", () => {
  const swings = [
    { type: "LOW", price: 100, index: 1 },
    { type: "HIGH", price: 120, index: 2 },
  ];
  const r = computeDealingRange(swings, null, 105); // 无结构 → RECENT fallback
  assert.equal(r.equilibrium, 110);
  assert.equal(r.location, "DISCOUNT");
  assert.equal(r.rangeType, "RECENT");
});

test("Dealing Range: price 高于中线 → PREMIUM", () => {
  const swings = [
    { type: "LOW", price: 100, index: 1 },
    { type: "HIGH", price: 120, index: 2 },
  ];
  const r = computeDealingRange(swings, null, 115);
  assert.equal(r.location, "PREMIUM");
});

// ---- V1.6 PD Array Audit ----

test("V1.6 FVG 带 direction 字段", () => {
  const candles = [
    candle(99, 100, 98, 99, 0),
    candle(108, 110, 105, 109, 1),
    candle(110, 112, 108, 111, 2),
  ];
  const fvgs = findFvgs(candles);
  assert.equal(fvgs[0].direction, "BULLISH");
});

test("V1.6 OB 带 confirmed: true", () => {
  const candles = [
    candle(102, 103, 98, 99, 0),
    candle(100, 107, 99, 106, 1),
  ];
  const obs = findOrderBlocks(candles);
  assert.equal(obs[0].confirmed, true);
});

test("L4 OB 细类: BREAKER（OB 被收盘穿透后收回 → 角色反转）", () => {
  const candles = [
    candle(102, 103, 98, 99, 0), // BULLISH_OB 区间 [98, 103]
    candle(100, 107, 99, 106, 1), // 阳线突破 → OB 确认
    candle(98, 98, 96, 96.5, 2), // 阴线收盘 96.5 < 98 → 穿透
    candle(97, 101, 96, 99.5, 3), // 阳线收盘 99.5 >= 98 → 收回
  ];
  const obs = findOrderBlocks(candles);
  const first = obs.find((o) => o.type === "BULLISH_OB");
  assert.equal(first.kind, "BREAKER");
  assert.equal(first.state, "USED"); // 突破 K 已访问 OB 区间
});

test("L4 OB 细类: REJECTION（OB 所在 K 长下影 → 机构拒绝）", () => {
  const candles = [
    candle(100.9, 101, 97.8, 100, 0), // 阴线 body=0.9，下影 100-97.8=2.2 >= 2*0.9
    candle(100, 108, 100.5, 107, 1), // 阳线突破，未回踩 OB
  ];
  const obs = findOrderBlocks(candles);
  assert.equal(obs[0].kind, "REJECTION");
});

test("L4 OB 细类: 未回踩 → FRESH；无穿透无拒绝 → STANDARD", () => {
  const candles = [
    candle(102, 103, 98, 99, 0), // 阴线
    candle(104, 107, 105, 106, 1), // 阳线突破，low 105 > 103 未触及 OB
  ];
  const obs = findOrderBlocks(candles);
  assert.equal(obs[0].kind, "STANDARD");
  assert.equal(obs[0].state, "FRESH");
});

test("L4 OB 细类: BEARISH_OB 穿透后收回 → BREAKER", () => {
  const candles = [
    candle(99, 104, 98, 103, 0), // BEARISH_OB 区间 [98, 104]
    candle(102, 103, 95, 96, 1), // 阴线跌破 → OB 确认
    candle(97, 103, 96, 104.5, 2), // 阳线收盘 104.5 > 104 → 穿透
    candle(104, 104, 100, 101, 3), // 阴线收盘 101 <= 104 → 收回
  ];
  const obs = findOrderBlocks(candles);
  assert.equal(obs[0].type, "BEARISH_OB");
  assert.equal(obs[0].kind, "BREAKER");
});

test("V1.6 annotatePDArray: location / age / status(FILLED)", () => {
  // eq = 110：FVG 108-100 中点 104 < 110 → DISCOUNT
  const range = { equilibrium: 110 };
  const candles = [
    candle(99, 100, 98, 99, 0), // K1
    candle(108, 110, 105, 109, 1), // K2
    candle(110, 112, 108, 111, 2), // K3 → FVG 100-108
    candle(111, 113, 105, 112, 3), // 刺入 108 → FILLED
  ];
  const fvgs = findFvgs(candles);
  const annotated = annotatePDArray({ fvg: fvgs, ob: [] }, range, candles);
  assert.equal(annotated.fvg[0].location, "DISCOUNT");
  assert.equal(annotated.fvg[0].age, 1); // currentIndex 3 - index 2
  assert.equal(annotated.fvg[0].status, "FILLED");
});

test("V1.6 rankPDArray: Bullish bias + Discount Bullish FVG → Primary VALID", () => {
  const pd = {
    fvg: [{ type: "BULLISH_FVG", direction: "BULLISH", top: 108, bottom: 100, index: 2, age: 5, status: "OPEN" }],
    ob: [],
  };
  const r = rankPDArray({ bias: "BULLISH", range: { equilibrium: 110 }, pdArray: pd });
  assert.equal(r.primary.type, "BULLISH_FVG");
  assert.equal(r.primary.price, 100); // bullish FVG 参考价 = bottom
  assert.equal(r.primary.status, "VALID");
  assert.equal(r.primary.score, 90); // 60 同向 + 30 顺位
});

test("V1.6 rankPDArray: Bullish bias + Premium FVG → primary null（Ignore）", () => {
  const pd = {
    fvg: [{ type: "BULLISH_FVG", direction: "BULLISH", top: 118, bottom: 112, index: 2, age: 5, status: "OPEN" }],
    ob: [],
  };
  // 中点 115 > eq 110 → PREMIUM（顺位应 DISCOUNT）
  const r = rankPDArray({ bias: "BULLISH", range: { equilibrium: 110 }, pdArray: pd });
  assert.equal(r.primary, null);
  assert.equal(r.alternatives[0].status, "COUNTER_LOCATION");
});

test("V1.6 rankPDArray: 反向 FVG（Bearish）+ Bullish bias → Ignore", () => {
  const pd = {
    fvg: [{ type: "BEARISH_FVG", direction: "BEARISH", top: 105, bottom: 100, index: 2, age: 5, status: "OPEN" }],
    ob: [],
  };
  const r = rankPDArray({ bias: "BULLISH", range: { equilibrium: 110 }, pdArray: pd });
  assert.equal(r.primary, null);
  assert.deepEqual(r.alternatives, []);
});
