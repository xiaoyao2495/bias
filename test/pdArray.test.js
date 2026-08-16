/**
 * pdArray 与 dealingRange 单元测试：FVG、Order Block、Premium/Discount
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { annotateFvgQuality, findFvgs, findOrderBlocks, annotatePDArray, inferTickSize, isExecutableFvg, isIctValidFvg, rankPDArray } from "../indicators/pdArray.js";
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
  assert.equal(raw.ictValid, true);
  assert.equal(raw.executionQuality, "STANDARD");
  assert.equal(raw.valid, true);
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

test("5m FVG语义分层：极窄缺口仍是ICT FVG，但不可作为工程执行区", () => {
  const candles = [
    candle(99.5, 100, 99, 99.8, 0),
    candle(99.8, 100.2, 99.6, 100.1, 1),
    candle(100.1, 100.5, 100.01, 100.3, 2),
  ];
  const annotated = annotatePDArray({ fvg: findFvgs(candles), ob: [] }, null, candles).fvg;
  const [fvg] = annotateFvgQuality(annotated, candles, { tickSize: 0.01 });
  assert.equal(fvg.ictValid, true);
  assert.equal(fvg.valid, true);
  assert.equal(isIctValidFvg(fvg), true);
  assert.equal(fvg.executable, false);
  assert.equal(fvg.meetsExecutionWidth, false);
  assert.equal(fvg.executionQuality, "THIN");
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

test("FVG完全被wick穿越后原区不再可执行", () => {
  const rows = [
    candle(99, 100, 98, 99, 0),
    candle(100, 110, 99, 109, 1),
    candle(109, 112, 108, 111, 2),
    candle(108, 109, 99, 105, 3),
  ];
  const annotated = annotatePDArray({ fvg: findFvgs(rows), ob: [] }, null, rows).fvg;
  const [fvg] = annotateFvgQuality(annotated, rows, { tickSize: 0.1, displacements: [{ index: 1, confirmationIndex: 2, fvg: { bottom: 100, top: 108 } }] });
  assert.equal(fvg.executionStatus, "WICK_FILLED");
  assert.equal(fvg.ictValid, false);
  assert.equal(isIctValidFvg(fvg), false);
  assert.equal(fvg.executable, false);
  assert.equal(fvg.rejectionReason, "MITIGATED");
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

test("FVG稳定id不依赖滚动窗口index", () => {
  const k1 = candle(99, 100, 98, 99, 1000);
  const k2 = candle(100, 109, 99, 108, 2000);
  const k3 = candle(108, 111, 105, 110, 3000);
  const before = [candle(99, 99, 98, 99, 0), k1, k2, k3];
  const after = [k1, k2, k3, candle(110, 112, 109, 111, 4000)];
  const idOf = (candles) => annotateFvgQuality(
    annotatePDArray({ fvg: findFvgs(candles), ob: [] }, null, candles).fvg,
    candles,
    { tickSize: 0.1 },
  ).find((fvg) => fvg.bottom === 100 && fvg.top === 105).id;

  assert.equal(idOf(before), idOf(after));
  assert.match(idOf(before), /_2000_100_105$/);
});

function structuralDisp(index, direction, swingIndex = 0) {
  return {
    index,
    direction,
    quality: "HIGH",
    structureBreak: { type: "BOS", direction, level: direction === "UP" ? 103 : 98, swingIndex },
  };
}

function displacementMss(index, direction, swingIndex = 0) {
  return {
    id: `mss-${direction}-${index}`,
    type: "MSS",
    direction,
    confirmed: true,
    confirmedByDisplacement: true,
    displacementIndex: index,
    swingIndex,
    level: direction === "UP" ? 103 : 98,
  };
}

function displacementBos(index, direction, swingIndex = 0) {
  return {
    ...displacementMss(index, direction, swingIndex),
    id: `bos-${direction}-${index}`,
    type: "BOS",
  };
}

test("严格 OB：只有阴线后强阳突破、没有结构位移 → 不生成 Bullish OB", () => {
  const candles = [
    candle(102, 103, 98, 99, 0), // 阴线
    candle(100, 107, 99, 106, 1), // 阳线突破 prev.high
  ];
  const obs = findOrderBlocks(candles);
  assert.deepEqual(obs, []);
});

test("严格 OB：只有阳线后强阴跌破、没有结构位移 → 不生成 Bearish OB", () => {
  const candles = [
    candle(99, 104, 98, 103, 0), // 阳线
    candle(102, 103, 95, 96, 1), // 阴线跌破 prev.low
  ];
  const obs = findOrderBlocks(candles);
  assert.deepEqual(obs, []);
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

test("严格 Bullish OB：结构上破位移前最后一根阴线，创建腿不算回踩", () => {
  const candles = [
    candle(102, 103, 98, 99, 0),
    candle(100, 107, 99, 106, 1),
  ];
  const [ob] = findOrderBlocks(candles, { displacements: [structuralDisp(1, "UP")] });
  assert.equal(ob.confirmed, true);
  assert.equal(ob.ict, true);
  assert.equal(ob.type, "BULLISH_OB");
  assert.equal(ob.high, 103);
  assert.equal(ob.low, 98);
  assert.equal(ob.midpoint, 100.5);
  assert.equal(ob.state, "FRESH");
  assert.equal(ob.sourceIndex, 0);
  assert.equal(ob.index, 1);
});

test("严格 Bearish OB：结构下破位移前最后一根阳线，多空字段镜像", () => {
  const candles = [
    candle(99, 104, 98, 103, 0),
    candle(102, 103, 95, 96, 1),
  ];
  const [ob] = findOrderBlocks(candles, { displacements: [structuralDisp(1, "DOWN")] });
  assert.equal(ob.type, "BEARISH_OB");
  assert.equal(ob.state, "FRESH");
  assert.equal(ob.proximal, 98);
  assert.equal(ob.distal, 104);
});

test("OB 生命周期：浅触及 → MITIGATED；触及 CE 后只升级不降级", () => {
  const candles = [
    candle(102, 103, 98, 99, 0),
    candle(100, 108, 99, 107, 1),
    candle(106, 107, 102, 106, 2),
  ];
  const shallow = findOrderBlocks(candles, { displacements: [structuralDisp(1, "UP")] })[0];
  assert.equal(shallow.state, "MITIGATED");
  const deeper = [...candles, candle(104, 105, 100, 104, 3), candle(106, 107, 102, 106, 4)];
  const ce = findOrderBlocks(deeper, { displacements: [structuralDisp(1, "UP")] })[0];
  assert.equal(ce.state, "CE_REACHED");
  assert.equal(ce.ceReachedAt, 3);
});

test("失败 Bullish OB：原对象 INVALIDATED，只有反向结构位移才派生 Bearish Breaker", () => {
  const candles = [
    candle(102, 103, 98, 99, 0),
    candle(100, 108, 99, 107, 1),
    candle(106, 107, 95, 96, 2),
    candle(97, 101, 96, 97, 3),
  ];
  const obs = findOrderBlocks(candles, {
    displacements: [structuralDisp(1, "UP"), structuralDisp(2, "DOWN", 1)],
    structureEvents: [displacementBos(1, "UP"), displacementMss(2, "DOWN", 1)],
  });
  const original = obs.find((o) => o.type === "BULLISH_OB");
  const breaker = obs.find((o) => o.type === "BEARISH_BREAKER");
  assert.equal(original.state, "INVALIDATED");
  assert.equal(original.executable, false);
  assert.equal(breaker.direction, "BEARISH");
  assert.equal(breaker.kind, "BREAKER");
  assert.equal(breaker.sourceObId, original.id);
  assert.equal(breaker.state, "CE_REACHED");
});

test("OB 被普通收破或反向 BOS 穿透：失效但不冒充 Breaker", () => {
  const candles = [
    candle(102, 103, 98, 99, 0),
    candle(100, 108, 99, 107, 1),
    candle(106, 107, 95, 96, 2),
  ];
  const obs = findOrderBlocks(candles, {
    displacements: [structuralDisp(1, "UP"), structuralDisp(2, "DOWN", 1)],
  });
  assert.equal(obs[0].state, "INVALIDATED");
  assert.equal(obs.some((o) => o.kind === "BREAKER"), false);
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

test("实盘回归：执行价越过本轮 dealing range 失效边界的旧 FVG 不得成为 Primary/Alternative", () => {
  const bullish = rankPDArray({
    bias: "BULLISH",
    range: { low: 902, high: 988.27, equilibrium: 945.135 },
    pdArray: {
      fvg: [
        { type: "BULLISH_FVG", direction: "BULLISH", top: 876.25, bottom: 870.67, status: "OPEN", executable: true, age: 10 },
        { type: "BULLISH_FVG", direction: "BULLISH", top: 930, bottom: 920, status: "OPEN", executable: true, age: 5 },
      ],
      ob: [],
    },
  });
  assert.equal(bullish.primary.price, 920);
  assert.equal(bullish.alternatives.some((x) => x.bottom === 870.67), false);

  const bearish = rankPDArray({
    bias: "BEARISH",
    range: { low: 100, high: 200, equilibrium: 150 },
    pdArray: {
      fvg: [
        { type: "BEARISH_FVG", direction: "BEARISH", top: 230, bottom: 220, status: "OPEN", executable: true, age: 3 },
        { type: "BEARISH_FVG", direction: "BEARISH", top: 180, bottom: 170, status: "OPEN", executable: true, age: 3 },
      ],
      ob: [],
    },
  });
  assert.equal(bearish.primary.price, 180);
  assert.equal(bearish.alternatives.some((x) => x.top === 230), false);
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

test("RECENT 中点不得给 FVG/OB 排执行顺位", () => {
  const out = rankPDArray({
    bias: "BULLISH",
    range: { rangeType: "RECENT", low: 90, high: 120, equilibrium: 105 },
    pdArray: {
      fvg: [{ type: "BULLISH_FVG", direction: "BULLISH", top: 102, bottom: 100, status: "OPEN", executable: true }],
      ob: [],
    },
  });
  assert.deepEqual(out, { primary: null, alternatives: [] });
});

test("严格 OB 排名门禁：排除非 ICT 区域与已失效 OB，只保留有效 Breaker", () => {
  const r = rankPDArray({
    bias: "BEARISH",
    range: { low: 90, high: 130, equilibrium: 105 },
    pdArray: {
      fvg: [],
      ob: [
        { type: "BEARISH_OB", direction: "BEARISH", high: 120, low: 115, age: 2, status: "FRESH", executable: true },
        { type: "BEARISH_OB", direction: "BEARISH", high: 119, low: 114, age: 2, status: "INVALIDATED", ict: true, executable: false },
        { id: "breaker-1", type: "BEARISH_BREAKER", direction: "BEARISH", kind: "BREAKER", high: 118, low: 112, top: 118, bottom: 112, age: 3, status: "MITIGATED", lifecycleState: "MITIGATED", ict: true, executable: true },
      ],
    },
  });
  assert.equal(r.primary.type, "BEARISH_BREAKER");
  assert.equal(r.primary.id, "breaker-1");
  assert.equal(r.primary.lifecycleState, "MITIGATED");
  assert.equal(r.primary.score, 80);
  assert.deepEqual(r.alternatives, []);
});

test("annotatePDArray 保留严格 OB 生命周期，不把回踩改写成 FILLED", () => {
  const candles = [
    candle(102, 103, 98, 99, 0),
    candle(100, 108, 99, 107, 1),
    candle(106, 107, 102, 106, 2),
  ];
  const ob = findOrderBlocks(candles, { displacements: [structuralDisp(1, "UP")] })[0];
  const annotated = annotatePDArray({ fvg: [], ob: [ob] }, { equilibrium: 110 }, candles).ob[0];
  assert.equal(annotated.status, "MITIGATED");
  assert.equal(annotated.lifecycleState, "MITIGATED");
  assert.equal(annotated.location, "DISCOUNT");
});

test("确认且由位移交付的 MSS 可建立 OB；普通位移不能", () => {
  const candles = [
    candle(102, 103, 98, 99, 0),
    candle(100, 108, 99, 107, 1),
  ];
  const d = { index: 1, direction: "UP", quality: "HIGH", structureBreak: null };
  assert.deepEqual(findOrderBlocks(candles, { displacements: [d] }), []);
  assert.deepEqual(
    findOrderBlocks(candles, { displacements: [structuralDisp(1, "UP")], structureEvents: [] }),
    [],
    "正式调用显式传入结构事件后，不得用 displacement 的 1/1 BOS 标签旁路统一结构口径",
  );
  const structureEvents = [{
    id: "mss-1",
    type: "MSS",
    direction: "UP",
    confirmed: true,
    confirmedByDisplacement: true,
    displacementIndex: 1,
    swingIndex: 0,
    level: 103,
    rangeId: "range-1",
  }];
  const [ob] = findOrderBlocks(candles, { displacements: [d], structureEvents });
  assert.equal(ob.structureEventType, "MSS");
  assert.equal(ob.structureEventId, "mss-1");
  assert.equal(ob.rangeId, "range-1");
});

test("Bullish Breaker 多空镜像：失败 Bearish OB 经向上结构位移后翻为多头", () => {
  const candles = [
    candle(99, 104, 98, 103, 0),
    candle(102, 103, 95, 96, 1),
    candle(97, 107, 96, 106, 2),
    candle(105, 106, 100, 105, 3),
  ];
  const obs = findOrderBlocks(candles, {
    displacements: [structuralDisp(1, "DOWN"), structuralDisp(2, "UP", 1)],
    structureEvents: [displacementBos(1, "DOWN"), displacementMss(2, "UP", 1)],
  });
  const original = obs.find((o) => o.type === "BEARISH_OB");
  const breaker = obs.find((o) => o.type === "BULLISH_BREAKER");
  assert.equal(original.state, "INVALIDATED");
  assert.equal(breaker.direction, "BULLISH");
  assert.equal(breaker.state, "CE_REACHED");
});

test("OB 稳定 id 不依赖滚动窗口 index", () => {
  const source = { time: 1000, open: 102, high: 103, low: 98, close: 99, closeTime: 1499 };
  const impulse = { time: 2000, open: 100, high: 108, low: 99, close: 107, closeTime: 2499 };
  const before = [candle(100, 101, 99, 100, -1), source, impulse];
  const after = [source, impulse, { time: 3000, open: 106, high: 109, low: 104, close: 108, closeTime: 3499 }];
  const a = findOrderBlocks(before, { displacements: [structuralDisp(2, "UP", 1)] })[0];
  const b = findOrderBlocks(after, { displacements: [structuralDisp(1, "UP", 0)] })[0];
  assert.equal(a.id, b.id);
  assert.match(a.id, /BULLISH_OB_1000_98_103/);
});

// ---- 结构位移与 OB 关联 ----
// 构造：前 19 根小实体横盘（avg body ≈ 0.2）→ K19 swing high 101.5 → K20 小阴线（body 0.25，
// ratio < 1.5，不构成位移）→ K21 大阳线（body 14.2，BODY 达标位移；fixture 无量跳过量门槛）
// 期望：仅结构上破位移产生 1 个 BULLISH_OB

function dispCandle(o, h, l, c, i) {
  return { time: i * 1000, open: o, high: h, low: l, close: c, closeTime: i * 1000 + 500 };
}

test("结构位移驱动 OB：BODY 达标且收破 swing 的位移腿生成 OB", () => {
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

test("无结构位移时不再使用阴阳线 fallback", () => {
  const candles = [
    candle(102, 103, 98, 99, 0), // 阴线
    candle(100, 107, 99, 106, 1), // 阳线突破 prev.high，但没有结构位移证据
  ];
  const obs = findOrderBlocks(candles);
  assert.deepEqual(obs, []);
});
