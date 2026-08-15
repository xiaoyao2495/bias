/**
 * pdArray 与 dealingRange 单元测试：FVG、Order Block、Premium/Discount
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { annotateFvgQuality, findFvgs, findOrderBlocks, annotatePDArray, inferTickSize, isExecutableFvg, rankPDArray } from "../indicators/pdArray.js";
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

test("5m FVG质量：ATR/tick动态门槛 + RAW/DISPLACEMENT/STRUCTURE 分级", () => {
  const candles = [
    candle(99, 100, 98, 99, 0),
    candle(100, 109, 99, 108, 1),
    candle(108, 111, 105, 110, 2),
  ];
  const annotated = annotatePDArray({ fvg: findFvgs(candles), ob: [] }, null, candles).fvg;
  const raw = annotateFvgQuality(annotated, candles, { tickSize: 0.1 })[0];
  assert.equal(raw.quality, "RAW");
  assert.equal(raw.executable, true);
  assert.ok(raw.widthAtr > 0);
  assert.ok(raw.ticks >= 3);

  const displacement = { index: 1, confirmationIndex: 2, fvg: { bottom: 100, top: 105 } };
  const displaced = annotateFvgQuality(annotated, candles, { tickSize: 0.1, displacements: [displacement] })[0];
  assert.equal(displaced.quality, "DISPLACEMENT");
  const event = { type: "MSS", confirmed: true, confirmedByDisplacement: true, displacementIndex: 1, displacementConfirmationIndex: 2, displacementFvg: displacement.fvg };
  const structured = annotateFvgQuality(annotated, candles, { tickSize: 0.1, displacements: [displacement], structureEvents: [event] })[0];
  assert.equal(structured.quality, "STRUCTURE");
  assert.equal(isExecutableFvg(structured), true);
});

test("5m FVG动态门槛：极窄缺口即使几何成立也不可执行", () => {
  const candles = [
    candle(99.5, 100, 99, 99.8, 0),
    candle(99.8, 100.2, 99.6, 100.1, 1),
    candle(100.1, 100.5, 100.01, 100.3, 2),
  ];
  const annotated = annotatePDArray({ fvg: findFvgs(candles), ob: [] }, null, candles).fvg;
  const [fvg] = annotateFvgQuality(annotated, candles, { tickSize: 0.01 });
  assert.equal(fvg.executable, false);
  assert.equal(fvg.rejectionReason, "TOO_NARROW");
});

test("5m FVG消耗：wick填平与close填平分开记录", () => {
  const base = [
    candle(99, 100, 98, 99, 0),
    candle(100, 110, 99, 109, 1),
    candle(109, 112, 108, 111, 2),
  ];
  const wickRows = [...base, candle(108, 109, 99, 105, 3)];
  const wick = annotatePDArray({ fvg: findFvgs(wickRows), ob: [] }, null, wickRows).fvg[0];
  assert.equal(wick.status, "FILLED");
  assert.equal(wick.closeStatus, "TOUCHED");
  assert.equal(wick.executionStatus, "WICK_FILLED");
  assert.equal(wick.fillType, "WICK");

  const closeRows = [...base, candle(108, 109, 99, 99, 3)];
  const close = annotatePDArray({ fvg: findFvgs(closeRows), ob: [] }, null, closeRows).fvg[0];
  assert.equal(close.closeStatus, "FILLED");
  assert.equal(close.executionStatus, "FILLED");
  assert.equal(close.fillType, "CLOSE");
});

test("tick推断与低价FVG稳定id保留原始精度", () => {
  const candles = [
    candle(0.03981, 0.03982, 0.0398, 0.03981, 0),
    candle(0.03983, 0.0401, 0.03983, 0.04005, 1),
    candle(0.04008, 0.0402, 0.04001, 0.0401, 2),
  ];
  assert.equal(inferTickSize(candles), 0.00001);
  const annotated = annotatePDArray({ fvg: findFvgs(candles), ob: [] }, null, candles).fvg;
  const [fvg] = annotateFvgQuality(annotated, candles, { tickSize: 0.00001 });
  assert.match(fvg.id, /0\.03982_0\.04001$/);
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

test("V1.6 annotatePDArray: location / age / status", () => {
  // eq = 110：FVG 108-100 中点 104 < 110 → DISCOUNT
  const range = { equilibrium: 110 };
  const candles = [
    candle(99, 100, 98, 99, 0), // K1
    candle(108, 110, 105, 109, 1), // K2
    candle(110, 112, 108, 111, 2), // K3 → FVG 100-108
    candle(111, 113, 105, 112, 3), // 刺入 108（low 105 进入缺口但未到顺位端 100）→ TOUCHED
  ];
  const fvgs = findFvgs(candles);
  const annotated = annotatePDArray({ fvg: fvgs, ob: [] }, range, candles);
  assert.equal(annotated.fvg[0].location, "DISCOUNT");
  assert.equal(annotated.fvg[0].age, 1); // currentIndex 3 - index 2
  assert.equal(annotated.fvg[0].status, "TOUCHED"); // P1：仅进入缺口，未填平
});

test("P1 annotatePDArray: FVG 四态（OPEN/TOUCHED/CE_REACHED/FILLED）Bullish", () => {
  const range = { equilibrium: 110 };
  // FVG [100,108]（K2 形成）
  const base = (fills) => [
    candle(99, 100, 98, 99, 0),
    candle(108, 110, 105, 109, 1),
    candle(110, 112, 108, 111, 2), // → BULLISH_FVG [100,108]
    ...fills,
  ];
  // OPEN：后续 K 未进入缺口（low > 108）
  const open = annotatePDArray({ fvg: findFvgs(base([candle(111, 113, 109, 112, 3)])), ob: [] }, range, base([candle(111, 113, 109, 112, 3)]));
  assert.equal(open.fvg[0].status, "OPEN");
  // TOUCHED：low=105 进入缺口但 > bottom 100
  const touched = annotatePDArray({ fvg: findFvgs(base([candle(111, 113, 105, 112, 3)])), ob: [] }, range, base([candle(111, 113, 105, 112, 3)]));
  assert.equal(touched.fvg[0].status, "TOUCHED");
  // CE_REACHED：low=102 触及中点（mid=104）但未到远端 bottom 100
  const ce = annotatePDArray({ fvg: findFvgs(base([candle(103, 105, 102, 104, 3)])), ob: [] }, range, base([candle(103, 105, 102, 104, 3)]));
  assert.equal(ce.fvg[0].status, "CE_REACHED");
  // FILLED：触及远端（low ≤ bottom 100）＝缺口完全回补
  const filled = annotatePDArray({ fvg: findFvgs(base([candle(113, 114, 98, 112, 3)])), ob: [] }, range, base([candle(113, 114, 98, 112, 3)]));
  assert.equal(filled.fvg[0].status, "FILLED");
});

test("P1 annotatePDArray: FVG 四态 Bearish 对称", () => {
  const range = { equilibrium: 90 };
  // BEARISH FVG [95,105]（K2 形成：K2.high=103 < K0.low=105？构造 K0 low=105, K2 high=103）
  const base = (fills) => [
    candle(106, 107, 105, 106, 0), // K0 low=105
    candle(104, 105, 103, 104, 1), // K1
    candle(99, 103, 98, 99, 2), // K2 high=103 < 105 → BEARISH_FVG [95?,105]（bottom=K2.high=103）
    ...fills,
  ];
  const open = annotatePDArray({ fvg: findFvgs(base([candle(97, 100, 96, 99, 3)])), ob: [] }, range, base([candle(97, 100, 96, 99, 3)]));
  assert.equal(open.fvg[0].status, "OPEN"); // high 100 < bottom 103？→ OPEN（未进入）
  const touched = annotatePDArray({ fvg: findFvgs(base([candle(97, 103.5, 96, 99, 3)])), ob: [] }, range, base([candle(97, 103.5, 96, 99, 3)]));
  assert.equal(touched.fvg[0].status, "TOUCHED"); // high 103.5 进入缺口（≥ bottom 103）但未到中点 104
  // CE_REACHED：high=104.5 触及中点（mid=104）但未到远端 top 105
  const ce = annotatePDArray({ fvg: findFvgs(base([candle(100, 104.5, 103.5, 101, 3)])), ob: [] }, range, base([candle(100, 104.5, 103.5, 101, 3)]));
  assert.equal(ce.fvg[0].status, "CE_REACHED");
  const filled = annotatePDArray({ fvg: findFvgs(base([candle(107, 108, 97, 99, 3)])), ob: [] }, range, base([candle(107, 108, 97, 99, 3)]));
  assert.equal(filled.fvg[0].status, "FILLED"); // 触及远端（high ≥ top 105）＝完全回补
});

test("P1: FVG 消耗单向递增——先触及中点（CE_REACHED）后浅回踩不得降回 TOUCHED", () => {
  // Bullish FVG [100,108]（mid=104）：K3 low=102 触及中点 → CE_REACHED；K4 low=105 浅回踩（>mid）
  // 旧逐根覆盖会把状态降回 TOUCHED（扣分 −15 回升 −10，抬高 Confidence）
  const bullRows = [
    candle(99, 100, 98, 99, 0),
    candle(108, 110, 105, 109, 1),
    candle(110, 112, 108, 111, 2),
    candle(103, 105, 102, 104, 3), // 触及中点 low=102 ≤ mid 104
    candle(106, 108, 105, 107, 4), // 浅回踩 low=105 > mid
  ];
  const a = annotatePDArray({ fvg: findFvgs(bullRows), ob: [] }, { equilibrium: 110 }, bullRows);
  assert.equal(a.fvg[0].status, "CE_REACHED");
  // Bearish 对称：BEARISH FVG [103,105]（mid=104）high 触及中点后浅回踩不得降回 TOUCHED
  const bearRows = [
    candle(106, 107, 105, 106, 0),
    candle(104, 105, 103, 104, 1),
    candle(99, 103, 98, 99, 2),
    candle(100, 104.5, 103.5, 101, 3), // 触及中点 high=104.5 ≥ mid 104
    candle(99, 103.5, 102, 102, 4), // 浅回踩 high=103.5 < mid
  ];
  const ba = annotatePDArray({ fvg: findFvgs(bearRows), ob: [] }, { equilibrium: 110 }, bearRows);
  assert.equal(ba.fvg[0].status, "CE_REACHED");
});

test("P1 rankPDArray: FVG 消耗分级扣分（OPEN 90 > TOUCHED 80 > CE_REACHED 75），FILLED 彻底失效排除", () => {
  const pd = (status) => ({ fvg: [{ type: "BULLISH_FVG", direction: "BULLISH", top: 108, bottom: 100, index: 2, age: 5, status }], ob: [] });
  const s = (status) => rankPDArray({ bias: "BULLISH", range: { equilibrium: 110 }, pdArray: pd(status) }).primary.score;
  assert.equal(s("OPEN"), 90);
  assert.equal(s("TOUCHED"), 80);
  assert.equal(s("CE_REACHED"), 75);
  // P1：FILLED（触及远端 = 缺口完全回补）→ 彻底失效，不进入候选（不能成为 Primary/Alternative）
  const r = rankPDArray({ bias: "BULLISH", range: { equilibrium: 110 }, pdArray: pd("FILLED") });
  assert.equal(r.primary, null);
  assert.deepEqual(r.alternatives, []);
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

// ---- V2.0 OB-Displacement 关联（ICT 2022：OB = 导致 Displacement 的 K 的前一根）----
// 构造：前 19 根小实体横盘（avg body ≈ 0.2）→ K19 swing high 101.5 → K20 小阴线（body 0.25，
// ratio < 1.5，不构成位移）→ K21 大阳线（body 14.2，BODY 达标位移；fixture 无量跳过量门槛）
// 期望：仅生成 1 个 BULLISH_OB（displacement: true），fallback 简化规则因区间重叠被去重

function dispCandle(o, h, l, c, i) {
  return { time: i * 1000, open: o, high: h, low: l, close: c, closeTime: i * 1000 + 500 };
}

test("V2.0 位移驱动 OB：BODY 达标位移 K 的前一根生成 OB（displacement: true），fallback 去重", () => {
  const candles = [];
  for (let i = 0; i < 19; i++) candles.push(dispCandle(100, 100.6, 99.8, 100.2, i)); // 横盘小实体（body 0.2）
  candles.push(dispCandle(100.2, 101.5, 100.0, 100.4, 19)); // K19: swing high 101.5
  candles.push(dispCandle(101.2, 101.4, 100.6, 100.95, 20)); // K20: 小阴线（body 0.25 < 1.5× avg，非位移）
  candles.push(dispCandle(100.8, 116, 102, 115, 21)); // K21: 大阳线位移（BODY 达标）

  const obs = findOrderBlocks(candles);
  assert.equal(obs.length, 1);
  assert.equal(obs[0].type, "BULLISH_OB");
  assert.equal(obs[0].high, 101.4);
  assert.equal(obs[0].low, 100.6);
  assert.equal(obs[0].displacement, true);
});

test("V2.0 无位移时 fallback 简化规则仍工作（displacement: false）", () => {
  const candles = [
    candle(102, 103, 98, 99, 0), // 阴线
    candle(100, 107, 99, 106, 1), // 阳线突破 prev.high（无位移三条件 → 走 fallback）
  ];
  const obs = findOrderBlocks(candles);
  assert.equal(obs.length, 1);
  assert.equal(obs[0].type, "BULLISH_OB");
  assert.equal(obs[0].displacement, false);
});
