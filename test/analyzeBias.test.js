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
import { analyzeBias } from "../engine/analyzeBias.js";
import { computeConfidence } from "../engine/confidence.js";

const H4 = 4 * 3600_000;
const D1 = 24 * 3600_000;
const W1 = 7 * D1;
const T0 = 1_700_000_000_000;

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

test("P0-4: sessionCandle 决定 Session —— 进行中 4H 时间范围命中活跃窗口，已收盘末根不命中", () => {
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
  // 不传 sessionCandle：回退已收盘 4H 末根（T0 末根北京 06:00-10:00）→ 不命中 20-24 → null
  const r1 = analyzeBias(base);
  assert.equal(r1.session, null);
  // 传 sessionCandle（进行中 4H：北京 20:00-24:00）→ 命中活跃窗口
  const t20 = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate(), 12, 0, 0); // UTC 12:00 = 北京 20:00
  const r2 = analyzeBias({ ...base, sessionCandle: { time: t20, closeTime: t20 + H4, open: 1, high: 1, low: 1, close: 1 } });
  assert.ok(r2.session, "进行中 4H 时间范围应命中活跃窗口");
  assert.equal(r2.session.start, 20);
  assert.equal(r2.session.end, 24);
  // 进行中 K 只用于 Session，不参与结构（swings 结构应与不传时一致）
  assert.equal(r1.structure.lastHigh.price, r2.structure.lastHigh.price);
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
  assert.equal(r.liquidity.primaryBuyDraw.type, "PWH");

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
  assert.equal(r.bias.draw.primary.type, "PWH");

  // PD Array：结构化输出（fvg/ob 数组），供执行区展示
  assert.ok(Array.isArray(r.pdArray.fvg));
  assert.ok(Array.isArray(r.pdArray.ob));
  assert.equal(typeof r.bias.pdArray.primary, "object");

  // Confidence：共用链路派生（continuation 25 + HTF 对齐 15 + PD aligned 25 + 流动性 10 - 回撤位 10）
  assert.equal(r.bias.confidence.level, "MEDIUM");
  assert.equal(r.bias.confidence.score, 65);
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
 * 最近 swing low(140) 高于保护位(130)。价格跌破 140 但未破 130 → 应判 MSS（INVALIDATED）。
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

test("P0-1: 价格跌破最近 swing low（未破保护位）→ MSS，effectiveBias 转 NEUTRAL（ICT：MSS = 打破最近 swing）", () => {
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
  assert.equal(r.bias.mss.level, 140); // MSS 基准 = 被打破的最近 swing，而非深位保护位
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

test("Session: 当前 4H 处于活跃窗口（Killzone）→ confidence +10（ICT：Killzone 内信号更有效）", () => {
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
  assert.equal(without.score, 20); // 基准（P0-2 base 20，无 Killzone）
  const inKz = computeConfidence({ ...base, session: { start: 21, end: 24, ratio: 26.7 } });
  assert.equal(inKz.score, 30); // +10 Killzone active
  assert.ok(inKz.factors.some((f) => f.name === "Killzone active" && f.value === "+10"));
});

test("P1: analysisTime 决定盘前流动性截断 —— 21:30 时 20:00–21:00 已收盘 1H K 不再被遗漏", () => {
  const H1 = 3600_000;
  const tCut = Date.UTC(2024, 1, 13, 12, 0, 0); // UTC 12:00 = 北京 20:00（最后已收盘 4H 结束时间）
  const tAnalysis = tCut + 90 * 60_000; // 北京 21:30（最近已收盘 5m 时间）
  // 北京 16:00~21:00 六根 1H K（UTC 08:00~13:00）；20:00-21:00 那根（UTC 12:00）带极端高低点
  const h1 = [];
  for (let h = 0; h < 6; h++) {
    const t = tCut - 4 * H1 + h * H1;
    const extreme = h === 4; // 北京 20:00-21:00
    h1.push({ time: t, open: 100, high: extreme ? 999 : 110, low: extreme ? 1 : 90, close: 100, closeTime: t + H1 - 1 });
  }
  const rNo = analyzeBias({ candles: h4Bull(), daily: [], weekly: [], price: 118, time: tCut, h1 });
  const rYes = analyzeBias({ candles: h4Bull(), daily: [], weekly: [], price: 118, time: tCut, analysisTime: tAnalysis, h1 });
  const pmh = (liq) => liq.buySide.find((x) => x.type === "PRE_MARKET_HIGH");
  const pml = (liq) => liq.sellSide.find((x) => x.type === "PRE_MARKET_LOW");
  // 不传 analysisTime（回退 time = 20:00）→ 20:00-21:00 已收盘 1H K 被遗漏 → 盘前区间不含极端值
  assert.equal(pmh(rNo.liquidity).price, 110);
  assert.equal(pml(rNo.liquidity).price, 90);
  // 传 analysisTime（21:30）→ 盘前区间统计到 21:00 已收盘 K → 含极端值
  assert.equal(pmh(rYes.liquidity).price, 999);
  assert.equal(pml(rYes.liquidity).price, 1);
  // 结构不受 analysisTime 影响（结构仍只用已收盘 4H candles）
  assert.equal(rNo.structure.direction, rYes.structure.direction);
});
