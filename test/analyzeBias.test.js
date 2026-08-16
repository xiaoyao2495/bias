/**
 * analyzeBias.test.js — 共用 Bias 分析链路（engine/analyzeBias.js）单元测试
 *
 * 覆盖审计 m3"消除重复链路"的关键约定，锁定 实时监控 / 回放 / 审计 结果一致：
 *   - htfDirection 注入：4H 方向与日线方向一致 → TREND_CONTINUATION；
 *     analyze.js 曾缺该参数导致 HTF 恒为 NEUTRAL（回归测试）
 *   - HTF 逐级兜底：日线无方向 → 周线；都无方向 → NEUTRAL → Scenario TRANSITION
 *   - 日/周线按 time 截断：进行中的日 K（closeTime > time）不得参与计算
 *   - 输出字段完整：structure / liquidity / location / pdArray / htfDirection / bias
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeBias, annotateStructureLiquidityStates, findReversalEvidence, reversalEvidenceFromEvents } from "../engine/analyzeBias.js";
import { computeConfidence } from "../engine/confidence.js";

const H4 = 4 * 3600_000;
const D1 = 24 * 3600_000;
const W1 = 7 * D1;
const T0 = 1_700_000_000_000;

test("4H External: pivot 右侧 2 根确认前的刺破不计为扫损", () => {
  const candles = Array.from({ length: 5 }, (_, i) => k(98, 98, 99, 97, T0 + i * H4, H4));
  candles[1].high = 100;
  candles[2].high = 101; // 尚在右侧确认期
  const structure = {
    externalSwingHigh: 100,
    externalSwingHighIndex: 1,
    externalSwingHighTime: candles[1].time,
    lastHigh: { price: 100, index: 1, time: candles[1].time },
  };

  annotateStructureLiquidityStates(structure, candles);
  assert.equal(structure.externalSwingHighState.state, "ACTIVE");
  assert.equal(structure.lastHighState.state, "ACTIVE");
});

/** 生成一根 K：time 为起点，closeTime = time + 周期 - 1 */
function k(o, c, h, l, time, span) {
  return { time, open: o, close: c, high: h, low: l, closeTime: time + span - 1 };
}

/** 4H 上升结构（32 根）：swings = LOW 90@4, HIGH 100@9, LOW 95@14, HIGH 112@19, LOW 107@24, HIGH 118@29 */
function h4Bull() {
  const rows = [
    [92.0, 92.5, 93.0, 91.0], [92.5, 93.0, 94.0, 91.5], [93.0, 93.5, 94.5, 92.0], [93.5, 94.0, 95.0, 92.5],
    [94.0, 92.0, 95.0, 90.0], [92.0, 93.0, 94.0, 92.0], [93.0, 94.0, 95.0, 92.5], [94.0, 95.0, 96.0, 93.0],
    [95.0, 96.0, 97.0, 93.5], [96.0, 97.0, 100.0, 94.0], [97.0, 98.0, 99.0, 94.5], [98.0, 99.0, 99.0, 95.0],
    [99.0, 98.0, 98.5, 95.5], [98.0, 98.0, 98.5, 95.6], [98.5, 97.0, 97.0, 95.0], [97.0, 98.5, 99.0, 96.0],
    [98.5, 99.5, 100.0, 96.5], [99.5, 101.0, 102.0, 97.0], [101.0, 103.0, 104.0, 98.0], [103.0, 106.0, 112.0, 100.0],
    [106.0, 107.0, 110.0, 108.0], [107.0, 107.5, 109.0, 108.5], [107.5, 108.0, 109.0, 108.0], [108.0, 108.5, 110.0, 108.5],
    [108.5, 107.5, 110.0, 107.0], [107.5, 109.5, 111.0, 108.5], [109.5, 111.0, 112.0, 109.0], [111.0, 113.0, 113.0, 110.0],
    [113.0, 115.0, 115.0, 111.0], [115.0, 117.0, 118.0, 112.0], [117.0, 117.5, 117.5, 113.0], [117.5, 117.0, 117.8, 114.0],
  ];
  return rows.map(([o, c, h, l], i) => k(o, c, h, l, T0 + i * H4, H4));
}

/** 日线上升结构（17 根）：swings = LOW 88@2, HIGH 100@6, LOW 96@11, HIGH 108@14 → BULLISH */
function dailyBull() {
  const rows = [
    [90.0, 91.0, 92.0, 89.0], [91.0, 92.0, 93.0, 89.5], [92.0, 90.0, 94.0, 88.0], [90.0, 93.0, 95.0, 90.0],
    [93.0, 95.0, 97.0, 91.0], [95.0, 96.0, 98.0, 92.0], [96.0, 97.0, 100.0, 93.0], [97.0, 98.0, 99.0, 94.0],
    [98.0, 97.0, 98.5, 95.0], [97.0, 99.0, 101.0, 96.5], [99.0, 100.0, 102.0, 97.0], [100.0, 98.0, 103.0, 96.0],
    [98.0, 101.0, 104.0, 98.0], [101.0, 103.0, 106.0, 99.0], [103.0, 104.0, 108.0, 100.0], [104.0, 105.0, 107.0, 101.0],
    [105.0, 104.0, 107.5, 102.0],
  ];
  return rows.map(([o, c, h, l], i) => k(o, c, h, l, T0 + i * D1, D1));
}

/** 周线上升结构（12 根）：swings = LOW 88@2, HIGH 105@6, LOW 92@9 → BULLISH；PWH = 125 */
function weeklyBull() {
  const rows = [
    [90, 92, 96, 90], [93, 95, 97, 91], [94, 93, 98, 88], [93, 96, 99, 94],
    [96, 98, 101, 96], [98, 99, 102, 97], [99, 101, 105, 98], [101, 102, 104, 99],
    [102, 101, 104, 100], [101, 100, 103, 92], [100, 103, 107, 101], [103, 105, 125, 102],
  ];
  return rows.map(([o, c, h, l], i) => k(o, c, h, l, T0 + i * W1, W1));
}

/** 覆盖全部日/周线的分析时刻（13 周，12 根周线全部已收盘） */
const TIME = T0 + 13 * W1;

test("P0: 反转证据存在扫损时返回该事件，不引用未定义变量", () => {
  const swept = { type: "PDL", price: 90, state: "SWEPT", sweptAt: T0 };
  const evidence = findReversalEvidence([], { direction: "BULLISH" }, { sellSide: [swept], buySide: [] });
  assert.equal(evidence.sweep, swept);
  assert.equal(evidence.confirmed, false);
  assert.equal(evidence.mss, null);
});

test("HTF反转统一因果链：只接受扫损后3根4H内的第一条位移MSS", () => {
  const identity = { originRangeId: "DR_HTF_TEST", rangeId: "DR_HTF_TEST", tradingDayId: "2026-08-16" };
  const swept = { type: "PDL", price: 90, state: "SWEPT", sweptAt: T0, sweepTradingDayId: identity.tradingDayId, ...identity };
  const displacementFvg = { bottom: 100, top: 101 };
  const valid = { type: "MSS", direction: "UP", confirmed: true, confirmedByDisplacement: true, displacementConfirmationIndex: 7, displacementFvg, displacementId: "DISP_HTF_TEST", time: T0 + 3 * H4, ...identity };
  // ATR/tick 判为过窄只影响下单过滤，不能否定课程意义上的 HTF 因果确认。
  const fvg = { ...displacementFvg, index: 7, quality: "STRUCTURE", ictValid: true, executable: false, displacementId: "DISP_HTF_TEST", ...identity };
  const evidence = reversalEvidenceFromEvents([valid], "BULLISH", [swept], 3, [fvg]);
  assert.equal(evidence.confirmed, true);
  assert.equal(evidence.sweep, swept);
  assert.equal(evidence.mss, valid);

  const late = { ...valid, time: T0 + 4 * H4 };
  assert.equal(reversalEvidenceFromEvents([late], "BULLISH", [swept], 3, [fvg]).confirmed, false);
});

test("HTF反转不跳过第一条普通结构收破去选择后面的位移MSS", () => {
  const swept = { type: "PDL", price: 90, state: "SWEPT", sweptAt: T0 };
  const ordinary = { type: "MSS", direction: "UP", confirmed: true, confirmedByDisplacement: false, time: T0 + H4 };
  const laterDisplacement = { type: "MSS", direction: "UP", confirmed: true, confirmedByDisplacement: true, time: T0 + 2 * H4 };
  const evidence = reversalEvidenceFromEvents([ordinary, laterDisplacement], "BULLISH", [swept]);
  assert.equal(evidence.confirmed, false);
  assert.equal(evidence.sweep, swept);
  assert.equal(evidence.mss, null);
});

test("P0-4: 活跃窗口按 analysisTime 命中，不读取进行中 4H 的未来覆盖范围", () => {
  const now = Date.now();
  const BJ = 8 * 3600_000;
  const bj = new Date(now + BJ);
  const today0 = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - BJ; // 北京今天 00:00
  const back = (bj.getUTCDay() + 6) % 7;
  const lastMon0 = today0 - back * D1 - 7 * D1; // 上周一 00:00（北京）
  // 上周一~五 1h 数据：北京 20-23 点高量 → 活跃窗口 [20,24]
  const h1 = [];
  for (let d = 0; d < 5; d++) {
    for (let h = 0; h < 24; h++) {
      const t = lastMon0 + d * D1 + h * 3600_000;
      const bjHour = new Date(t + BJ).getUTCHours();
      h1.push({ time: t, quoteVol: bjHour >= 20 && bjHour <= 23 ? 100 : 0 });
    }
  }
  const candles = h4Bull();
  const base = { candles, daily: [], weekly: [], price: 118, time: TIME, h1 };
  const t20 = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate(), 12, 0, 0); // UTC 12:00 = 北京 20:00
  const before = analyzeBias({ ...base, analysisTime: t20 - 10 * 60_000 }); // 19:50
  assert.equal(before.activeVolumeWindow, null);
  const inside = analyzeBias({ ...base, analysisTime: t20 + 10 * 60_000 }); // 20:10
  assert.ok(inside.activeVolumeWindow);
  assert.equal(inside.activeVolumeWindow.start, 20);
  assert.equal(inside.session.start, 20); // 旧字段兼容
  assert.equal(inside.bias.confidence.confluenceScore, before.bias.confidence.confluenceScore, "统计活跃窗口本身不得额外增加 ICT 共振评分");
  assert.equal(before.structure.lastHigh.price, inside.structure.lastHigh.price);
});

test("4H BULLISH + 日线 BULLISH → htfDirection 注入，Scenario TREND_CONTINUATION，输出字段完整", () => {
  const r = analyzeBias({ candles: h4Bull(), daily: dailyBull(), weekly: weeklyBull(), price: 108, time: TIME });

  // Structure：LL,HH,HL,HH,HL,HH → BULLISH；保护位 = 最后 HH(118) 前最近 LOW(107)
  assert.equal(r.structure.direction, "BULLISH");
  assert.equal(r.structure.type, "EXTERNAL_BULLISH");
  assert.equal(r.structure.protectedLow, 107);
  assert.equal(r.structure.externalSwingLow, 90);
  assert.deepEqual(r.structure.sequence, ["HH", "HL", "HH", "HL", "HH"]); // buildStructure 只保留最近 5 个

  // Liquidity：日/周线按 time 截断后取 lastCompleted → PDH 107.5 / PWH 125
  assert.ok(r.liquidity.buySide.some((x) => x.type === "PDH" && x.price === 107.5));
  assert.ok(r.liquidity.buySide.some((x) => x.type === "PWH" && x.price === 125));
  assert.equal(r.liquidity.primaryBuyDraw.type, "EXTERNAL_HIGH");
  assert.equal(r.liquidity.primaryBuyDraw.rangeClass, "ERL");

  // Location：Impulse Range = 最后 HH(118) → 前低(107)；price 108 < eq 112.5 → DISCOUNT_VALID
  assert.equal(r.location.rangeType, "IMPULSE_BULLISH");
  assert.equal(r.location.high, 118);
  assert.equal(r.location.low, 107);
  assert.equal(r.location.location, "DISCOUNT");
  assert.equal(r.location.context, "DISCOUNT_VALID");

  // HTF 方向注入（修复点）：日线 BULLISH → htfDirection BULLISH，而非 NEUTRAL
  assert.equal(r.htfDirection, "BULLISH");

  // Bias：方向由 Structure 决定；Scenario 体现 HTF 对齐
  assert.equal(r.bias.bias, "BULLISH");
  assert.equal(r.bias.structureStatus, "VALID");
  assert.equal(r.bias.effectiveBias, "BULLISH");
  assert.equal(r.bias.scenario.state, "TREND_CONTINUATION");
  assert.equal(r.bias.scenario.label, "BULLISH_CONTINUATION");
  assert.equal(r.bias.scenario.htfDirection, "BULLISH");
  assert.equal(r.bias.executionState, "READY");
  assert.equal(r.bias.draw.side, "BSL");
  assert.equal(r.bias.draw.primary.type, "EXTERNAL_HIGH");

  // PD Array：结构化输出（fvg/ob 数组），供执行区展示
  assert.ok(Array.isArray(r.pdArray.fvg));
  assert.ok(Array.isArray(r.pdArray.ob));
  assert.equal(typeof r.bias.pdArray.primary, "object");

  // Confidence：方向评分不再因 Discount/Premium 加减分（25 + 15 + 25 + 10）
  assert.equal(r.bias.confidence.level, "HIGH");
  assert.equal(r.bias.confidence.score, 75);
});

test("RECENT fallback 只作观察：不提供 Location、ERL/IRL、PD Array 或执行状态", () => {
  // 截到只有首个 LOW/HIGH 的阶段：已有最近高低点，但尚无 HH+HL / LH+LL 推动结构。
  const candles = h4Bull().slice(0, 12);
  const r = analyzeBias({ candles, daily: [], weekly: [], price: 98, time: candles.at(-1).closeTime });
  assert.equal(r.rangeCandidate.rangeType, "RECENT");
  assert.equal(r.dealingRangeReady, false);
  assert.equal(r.location.rangeType, "RECENT");
  assert.equal(r.location.lifecycleStatus, "OBSERVATION");
  assert.equal(r.location.rangeId, null);
  assert.equal(r.location.location, "UNKNOWN");
  assert.equal(r.liquidity.externalRange, null);
  assert.deepEqual(r.liquidity.internalRange, []);
  assert.deepEqual(r.bias.pdArray, { primary: null, alternatives: [] });
  assert.equal(r.bias.executionState, "NONE");
});

test("日线无方向（空）→ 周线兜底 → htfDirection 仍 BULLISH", () => {
  const r = analyzeBias({ candles: h4Bull(), daily: [], weekly: weeklyBull(), price: 108, time: TIME });
  assert.equal(r.htfDirection, "BULLISH");
  assert.equal(r.bias.scenario.label, "BULLISH_CONTINUATION");
  assert.equal(r.bias.bias, "BULLISH");
});

test("日/周线均无方向 → htfDirection NEUTRAL → Scenario TRANSITION（analyze.js 缺参回归测试）", () => {
  const r = analyzeBias({ candles: h4Bull(), daily: [], weekly: [], price: 108, time: TIME });
  assert.equal(r.htfDirection, "NEUTRAL");
  assert.equal(r.bias.scenario.state, "TRANSITION");
  assert.equal(r.bias.scenario.label, "TRANSITION");
  assert.equal(r.bias.scenario.htfDirection, "NEUTRAL");
  assert.equal(r.bias.bias, "BULLISH"); // 4H 方向仍由结构决定，只影响 Scenario 状态
});

test("日/周线按 time 截断：进行中的日 K（closeTime > time）不参与计算", () => {
  // 追加一根未来日 K（closeTime 在分析时刻之后）：若泄漏会污染 PDH(200)/结构
  const daily = [...dailyBull(), k(50, 60, 200, 50, T0 + 13 * W1 + 1, D1)];
  const r = analyzeBias({ candles: h4Bull(), daily, weekly: weeklyBull(), price: 108, time: TIME });

  assert.ok(r.liquidity.buySide.some((x) => x.type === "PDH" && x.price === 107.5)); // 仍取最后一根已收盘日 K
  assert.ok(!r.liquidity.buySide.some((x) => x.type === "PDH" && x.price === 200)); // 未来日 K 未泄漏
  assert.equal(r.htfDirection, "BULLISH"); // 结构判定同样不受未来 K 影响
});

/**
 * P0-1 fixture：BULLISH 结构（swings：LOW 100→HIGH 140→HL 130→HH 165→HL 140），
 * 最近 swing low(140) 高于保护位(130)。价格跌破 140 但未破 130 → 旧结构应失效；
 * fixture 没有 displacement 时语义为 STRUCTURE_BREAK，不冒充 ICT MSS。
 */
function h4MssFixture() {
  const rows = [
    [104, 105, 106, 103], [105, 106, 107, 104], [106, 102, 108, 100], [110, 138, 139, 109],
    [138, 139, 140, 133], [135, 133, 136, 131], [133, 131, 134, 130], [140, 155, 155, 134],
    [154, 163, 165, 153], [160, 161, 162, 141], [143, 141, 145, 140], [142, 142, 144, 141],
    [143, 142, 143, 141],
  ];
  return rows.map(([o, c, h, l], i) => k(o, c, h, l, T0 + i * H4, H4));
}

test("价格跌破最近 swing low（未破保护位）→ STRUCTURE_BREAK，effectiveBias 转 NEUTRAL", () => {
  const candles = h4MssFixture();
  // 结构确认：lastHigh = HH 165，lastLow = HL 140；保护位 = 130（HH 165 之前的 HL）
  const r = analyzeBias({ candles, daily: [], weekly: [], price: 135, time: TIME });
  assert.equal(r.structure.direction, "BULLISH");
  assert.equal(r.structure.protectedLow, 130);
  assert.equal(r.structure.lastLow.price, 140);
  // 135 <= 140（最近 swing low 被打破）但 135 > 130（深位保护位未破）→ 修复前 VALID，修复后 INVALIDATED
  assert.equal(r.bias.structureStatus, "INVALIDATED");
  assert.equal(r.bias.effectiveBias, "NEUTRAL");
  assert.ok(r.bias.mss);
  assert.equal(r.bias.mss.semanticType, "STRUCTURE_BREAK");
  assert.equal(r.bias.mss.ictMss, false);
  assert.equal(r.bias.mss.level, 140); // 结构破坏基准 = 被打破的最近 swing，而非深位保护位
  assert.equal(r.bias.mss.direction, "DOWN");
  assert.equal(r.bias.mss.structureFrom, "BULLISH");
});

test("P0-1 对照组: 价格未破最近 swing low → 结构保持 VALID", () => {
  const r = analyzeBias({ candles: h4MssFixture(), daily: [], weekly: [], price: 145, time: TIME });
  assert.equal(r.bias.structureStatus, "VALID");
  assert.equal(r.bias.effectiveBias, "BULLISH");
  assert.equal(r.bias.mss, null);
});

test("P0-2: computeConfidence — 结构确认 + 保护位有效 + HTF 中性（TRANSITION）→ base 20 而非 10", () => {
  const c = computeConfidence({
    bias: "BULLISH",
    structure: { direction: "BULLISH" },
    structureStatus: "VALID",
    location: { location: "DISCOUNT", context: "UNKNOWN", high: 120, low: 100 },
    draw: null,
    pdArray: null,
    price: 110,
    scenario: { state: "TRANSITION", htfDirection: "NEUTRAL" },
  });
  // base 20（结构确认但 HTF 中性）+ 无其他因子；修复前 base 10
  assert.equal(c.score, 20);
  assert.equal(c.level, "LOW");
});

test("P0-2 对照组: 结构失效的 TRANSITION → 硬门槛 LOW 0 不变", () => {
  const c = computeConfidence({
    bias: "BULLISH",
    structure: { direction: "BULLISH" },
    structureStatus: "INVALIDATED",
    location: { location: "DISCOUNT", context: "UNKNOWN", high: 120, low: 100 },
    draw: null,
    pdArray: null,
    price: 110,
    scenario: { state: "TRANSITION", htfDirection: "NEUTRAL" },
  });
  assert.equal(c.score, 0);
  assert.equal(c.level, "LOW");
});

test("ICT Session：固定课程时段命中时 confluenceScore +10", () => {
  const base = {
    bias: "BULLISH",
    structure: { direction: "BULLISH" },
    structureStatus: "VALID",
    location: { location: "DISCOUNT", context: "UNKNOWN", high: 120, low: 100 },
    draw: null,
    pdArray: null,
    price: 110,
    scenario: { state: "TRANSITION", htfDirection: "NEUTRAL" },
  };
  const without = computeConfidence(base);
  assert.equal(without.score, 20); // 基准（P0-2 base 20，无 ICT Session）
  const inKz = computeConfidence({ ...base, ictSession: { name: "NEW_YORK" } });
  assert.equal(inKz.score, 30);
  assert.ok(inKz.factors.some((f) => f.name === "ICT Session active" && f.value === "+10"));
});

test("P1: analysisTime 决定 09:25-09:30 ET 最后一根盘前 5m 是否已收盘", () => {
  const tCut = Date.UTC(2026, 7, 7, 13, 25); // 09:25 EDT，最后一根尚未收盘
  const tAnalysis = Date.UTC(2026, 7, 7, 13, 30); // 09:30 EDT，最后一根刚收盘
  const first = Date.UTC(2026, 7, 7, 8, 0); // 04:00 EDT
  const m5 = Array.from({ length: 66 }, (_, i) => ({
    time: first + i * 5 * 60_000,
    open: 100,
    high: i === 65 ? 999 : 110,
    low: i === 65 ? 1 : 90,
    close: 100,
    closeTime: first + (i + 1) * 5 * 60_000,
  }));
  const base = { symbol: "MUUSDT", candles: h4Bull(), daily: [], weekly: [], price: 118, time: tCut, m5 };
  const rNo = analyzeBias(base);
  const rYes = analyzeBias({ ...base, analysisTime: tAnalysis });
  const pmh = (liq) => liq.buySide.find((x) => x.type === "PRE_MARKET_HIGH");
  const pml = (liq) => liq.sellSide.find((x) => x.type === "PRE_MARKET_LOW");
  // 不传 analysisTime → 盘前尚未完成；形成中的高低会重绘，不得提前注入扫损池
  assert.equal(pmh(rNo.liquidity), undefined);
  assert.equal(pml(rNo.liquidity), undefined);
  // 传 09:30 analysisTime → 最后一根盘前 5m 已收盘，精确纳入
  assert.equal(pmh(rYes.liquidity).price, 999);
  assert.equal(pml(rYes.liquidity).price, 1);
  // 结构不受 analysisTime 影响（结构仍只用已收盘 4H candles）
  assert.equal(rNo.structure.direction, rYes.structure.direction);
});

test("riskLine 同侧防御：internalSwing.low 已被价格突破（在价格上方）→ 过滤，回退 4H 位", () => {
  const candles = h4Bull();
  const price = candles[candles.length - 1].close; // BULLISH，末根 close = 117
  // 错误注入：low 120 > price 117（已被突破的位），不能当失效线
  const r = analyzeBias({ candles, daily: dailyBull(), weekly: weeklyBull(), price, structurePrice: price, time: TIME, internalSwing: { low: 120, high: null } });
  assert.ok(r.bias.riskLine != null, "应有兜底 riskLine");
  assert.ok(r.bias.riskLine < price, `riskLine ${r.bias.riskLine} 应低于现价 ${price}`);
  assert.notEqual(r.bias.riskLine, 120, "已被突破的 internalSwing.low 应被同侧过滤");
});

test("riskLine 正常注入：internalSwing.low 在价格下方 → 优先采用（最近失效线）", () => {
  const candles = h4Bull();
  const price = candles[candles.length - 1].close;
  const r = analyzeBias({ candles, daily: dailyBull(), weekly: weeklyBull(), price, structurePrice: price, time: TIME, internalSwing: { low: 114.5, high: null } });
  assert.equal(r.bias.riskLine, 114.5); // 114.5 是最近的下方失效线（> 4H MSS 107）
});
