/**
 * liquidity 单元测试：PDH/PDL、PWH/PWL、EQH/EQL
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyDealingRangeLiquidity,
  computeLiquidity,
  findEqualHighClusters,
  findEqualHighs,
  findEqualLows,
  rankLiquidityTargets,
  findPremarketRange,
  findAsiaRange,
  isEquityLinkedSymbol,
  liquidityStateForLevel,
  resolveEqualLevelTolerance,
} from "../indicators/liquidity.js";

const now = Date.now();

/** closed=true → 已收盘（closeTime 在过去）；false → 未收盘（closeTime 在未来） */
function mkCandle(i, high, low, closed) {
  return {
    time: i,
    open: (high + low) / 2,
    high,
    low,
    close: (high + low) / 2,
    closeTime: closed ? now - 1000 : now + 100000,
  };
}

test("PDH/PDL/PWH/PWL: 取最近已收盘的日/周 K 线", () => {
  const daily = [mkCandle(0, 50000, 48000, true), mkCandle(1, 50500, 48500, false)];
  const weekly = [mkCandle(0, 60000, 52000, true), mkCandle(1, 61000, 53000, false)];

  const l = computeLiquidity(daily, weekly, [], 0.002);

  assert.deepEqual(l.buySide, [
    { type: "PWH", price: 60000, time: 0, group: "HTF", source: "EXCHANGE_UTC", sessionModel: "CRYPTO_24X7", activeFrom: daily[0].closeTime },
    { type: "PDH", price: 50000, time: 0, group: "HTF", source: "EXCHANGE_UTC", sessionModel: "CRYPTO_24X7", tradingDayId: "1970-01-01", activeFrom: daily[0].closeTime },
  ]);
  assert.deepEqual(l.sellSide, [
    { type: "PDL", price: 48000, time: 0, group: "HTF", source: "EXCHANGE_UTC", sessionModel: "CRYPTO_24X7", tradingDayId: "1970-01-01", activeFrom: daily[0].closeTime },
    { type: "PWL", price: 52000, time: 0, group: "HTF", source: "EXCHANGE_UTC", sessionModel: "CRYPTO_24X7", activeFrom: daily[0].closeTime },
  ]);
  // range/price 未知时不伪造固定主 Draw；主目标由 analyzeBias 绑定 dealing range 后生成。
  assert.equal(l.primaryBuyDraw, null);
  assert.equal(l.primarySellDraw, null);
});

test("EQH: 0.2% 容差内的多个高点归为等高点（含时间信息）", () => {
  const swings = [
    { type: "HIGH", price: 95, index: 1, time: 1001 },
    { type: "HIGH", price: 100.1, index: 2, time: 1002 },
    { type: "HIGH", price: 100.2, index: 3, time: 1003 },
    { type: "HIGH", price: 100.3, index: 4, time: 1004 },
  ];
  assert.deepEqual(findEqualHighs(swings, 0.002), {
    price: 100.3,
    touches: 3,
    firstIndex: 2,
    lastIndex: 4,
    firstTime: 1002,
    lastTime: 1004,
  });
});

test("EQL: 非传递聚类不会把首尾已超容差的价位链式吞并", () => {
  const swings = [
    { type: "LOW", price: 90.1, index: 1, time: 1001 },
    { type: "LOW", price: 90.2, index: 2, time: 1002 },
    { type: "LOW", price: 90.3, index: 3, time: 1003 },
    { type: "LOW", price: 110, index: 4, time: 1004 },
  ];
  assert.deepEqual(findEqualLows(swings, 0.002), {
    price: 90.2,
    touches: 2,
    firstIndex: 2,
    lastIndex: 3,
    firstTime: 1002,
    lastTime: 1003,
  });
});

test("EQH: 没有足够接近的高点 → null", () => {
  const swings = [
    { type: "HIGH", price: 100, index: 1 },
    { type: "HIGH", price: 150, index: 2 },
  ];
  assert.equal(findEqualHighs(swings, 0.002), null);
});

test("computeLiquidity: 输出包含 EQH/EQL", () => {
  const daily = [mkCandle(0, 50000, 48000, true)];
  const weekly = [mkCandle(0, 60000, 52000, true)];
  const swings = [
    { type: "HIGH", price: 100.1, index: 1, time: 1001 },
    { type: "HIGH", price: 100.2, index: 2, time: 1002 },
    { type: "LOW", price: 90.1, index: 3, time: 1003 },
    { type: "LOW", price: 90.2, index: 4, time: 1004 },
  ];
  const l = computeLiquidity(daily, weekly, swings, 0.002);

  const eqh = l.buySide.find((t) => t.type === "EQH");
  const eql = l.sellSide.find((t) => t.type === "EQL");
  assert.ok(eqh && eqh.price === 100.2);
  assert.ok(eql && eql.price === 90.1);
  // 形成时间贯通：EQH/EQL 带触点 swing 的 4H K 开盘时间（扫损消息"被扫的流动性是什么时候的"）
  assert.equal(eqh.firstTime, 1001);
  assert.equal(eqh.lastTime, 1002);
  assert.equal(eql.firstTime, 1003);
  assert.equal(eql.lastTime, 1004);
});

// ---- V1.5 rankLiquidityTargets ----

const structNoExt = {
  direction: "BULLISH",
  externalSwingHigh: null,
  externalSwingLow: null,
  lastHigh: null,
  lastLow: null,
};

test("动态 Draw：多头不套固定周高优先级，结合距离与池质量选择 PDH", () => {
  const liquidity = {
    buySide: [
      { type: "PWH", price: 190 },
      { type: "EQH", price: 185 },
      { type: "PDH", price: 170 },
    ],
    sellSide: [],
  };
  const r = rankLiquidityTargets(structNoExt, liquidity, "BULLISH", 150);
  assert.equal(r.primary.type, "PDH");
  assert.equal(r.primary.price, 170);
  assert.equal(r.primary.priority, null);
  // 备选仍按价格先后：EQH 185 → PWH 190
  assert.deepEqual(r.alternatives, [
    { type: "EQH", price: 185, score: r.alternatives[0].score },
    { type: "PWH", price: 190, score: r.alternatives[1].score },
  ]);
});

test("动态 Draw：空头可优先选择更集中的 EQL，而不是无条件选择 PWL", () => {
  const liquidity = {
    buySide: [],
    sellSide: [
      { type: "PWL", price: 100 },
      { type: "EQL", price: 110 },
      { type: "PDL", price: 120 },
    ],
  };
  const r = rankLiquidityTargets({ ...structNoExt, direction: "BEARISH" }, liquidity, "BEARISH", 150);
  assert.equal(r.primary.type, "EQL");
  assert.equal(r.primary.priority, null);
  assert.deepEqual(r.alternatives.map(({ type, price }) => ({ type, price })), [
    { type: "PDL", price: 120 }, { type: "PWL", price: 100 },
  ]);
});

test("V1.5 无任何目标 → primary 为 null（Draw = NONE）", () => {
  const liquidity = { buySide: [], sellSide: [] };
  const r = rankLiquidityTargets(structNoExt, liquidity, "BULLISH", 150);
  assert.equal(r.primary, null);
  assert.deepEqual(r.alternatives, []);
});

test("structure 的历史 external 字段不再被当成 ERL", () => {
  const structure = {
    direction: "BULLISH",
    externalSwingHigh: 220, // 未突破的外部高点 → 首要 BSL 目标
    externalSwingLow: null,
    lastHigh: { type: "HIGH", price: 200, label: "HH" },
    lastLow: null,
  };
  const liquidity = { buySide: [{ type: "PWH", price: 190 }], sellSide: [] };
  const r = rankLiquidityTargets(structure, liquidity, "BULLISH", 150);
  assert.equal(r.primary.type, "PWH");
  assert.equal(r.primary.price, 190);
});

test("V1.5 已突破的方向侧目标被过滤（价格不在正确一侧）", () => {
  const structure = { direction: "BULLISH", externalSwingHigh: 100, externalSwingLow: null, lastHigh: null, lastLow: null };
  const liquidity = { buySide: [{ type: "PDH", price: 160 }], sellSide: [] };
  // external high 100 已在价格下方（不构成上方目标，被过滤），PDH 160 在上方
  const r = rankLiquidityTargets(structure, liquidity, "BULLISH", 150);
  assert.equal(r.primary.type, "PDH");
  assert.equal(r.primary.price, 160);
});

// ---- V2.1 美股盘前区间（PRE_MARKET_HIGH/LOW）----
// America/New_York 04:00-09:30；粗周期 K 必须整根位于窗口内，推荐生产使用 5m。

test("V2.1 findPremarketRange: 粗周期不会把 09:30 后半小时混入盘前", () => {
  const T0 = Date.UTC(2026, 7, 7, 8, 0); // 北京 2026-08-07 16:00
  const h1 = [0, 1, 2, 3, 4, 5].map((i) => ({
    time: T0 + i * 3600_000,
    open: 100,
    high: 102 + i * 0.1,
    low: 98 + i * 0.1,
    close: 101,
    closeTime: T0 + (i + 1) * 3600_000,
  }));
  const r = findPremarketRange(h1, Date.UTC(2026, 7, 7, 14, 30)); // 北京 22:30（盘后）
  assert.equal(r.high, 102.4); // 21:00-22:00 北京 = 09:00-10:00 ET，跨过 09:30，整根排除
  assert.equal(r.low, 98); // 最低 low
  assert.equal(r.bars, 5);
  assert.equal(r.completed, false, "粗周期未覆盖 09:00-09:30，不得冒充完整盘前区间");
  assert.equal(r.date, "2026-08-07");
  assert.equal(r.highTime, T0 + 4 * 3600_000);
  assert.equal(r.lowTime, T0);
});

test("V2.0 findPremarketRange: 回放幂等 — now 只认已收盘 1H K", () => {
  const T0 = Date.UTC(2026, 7, 7, 8, 0);
  const h1 = [0, 1, 2, 3, 4, 5].map((i) => ({
    time: T0 + i * 3600_000,
    open: 100,
    high: 102 + i * 0.1,
    low: 98 + i * 0.1,
    close: 101,
    closeTime: T0 + (i + 1) * 3600_000,
  }));
  const r = findPremarketRange(h1, Date.UTC(2026, 7, 7, 10, 0)); // 北京 18:00：只有前 2 根收盘
  assert.equal(r.bars, 2);
  assert.equal(r.high, 102.1);
  assert.equal(r.low, 98);
});

test("V2.0 findPremarketRange: 无盘前时段 K（如全部为北京 22 点后）→ null", () => {
  const T0 = Date.UTC(2026, 7, 7, 14, 0); // 北京 22:00
  const h1 = [0, 1, 2, 3].map((i) => ({
    time: T0 + i * 3600_000,
    open: 100,
    high: 102,
    low: 98,
    close: 101,
    closeTime: T0 + (i + 1) * 3600_000,
  }));
  assert.equal(findPremarketRange(h1, Date.UTC(2026, 7, 7, 20, 0)), null);
});

test("V2.1 computeLiquidity: 美股关联 symbol 才注入 PRE_MARKET_HIGH/LOW", () => {
  const daily = [mkCandle(0, 50000, 48000, true)];
  const weekly = [mkCandle(0, 60000, 52000, true)];
  const T0 = Date.UTC(2026, 7, 7, 8, 0);
  const m5 = Array.from({ length: 66 }, (_, i) => ({
    time: T0 + i * 5 * 60_000,
    open: 100,
    high: 102 + i * 0.1,
    low: 98 + i * 0.1,
    close: 101,
    closeTime: T0 + (i + 1) * 5 * 60_000,
  }));
  const l = computeLiquidity(daily, weekly, [], 0.002, Date.UTC(2026, 7, 7, 14, 30), 150, m5, null, { symbol: "MUUSDT" });
  const pmh = l.buySide.find((t) => t.type === "PRE_MARKET_HIGH");
  const pml = l.sellSide.find((t) => t.type === "PRE_MARKET_LOW");
  assert.ok(pmh && pmh.price === 108.5);
  assert.ok(pml && pml.price === 98);
  assert.equal(pmh.time, T0 + 65 * 5 * 60_000);
  assert.equal(pml.time, T0);
});

test("周末只保留上个交易日盘前为历史参考，不冒充当前 Session Range", () => {
  const start = Date.UTC(2026, 7, 7, 8); // Fri 04:00 EDT
  const bars = Array.from({ length: 66 }, (_, i) => ({
    time: start + i * 300_000,
    closeTime: start + (i + 1) * 300_000,
    open: 100, high: 105 + i / 100, low: 95, close: 100,
  }));
  const sunday = Date.UTC(2026, 7, 9, 14); // Sun 10:00 EDT
  const liquidity = computeLiquidity([], [], [], null, sunday, 150, bars, null, { symbol: "MUUSDT" });
  assert.equal(liquidity.sessionRange, null);
  assert.equal(liquidity.referenceSessionRange.name, "PRE_MARKET");
  assert.equal(liquidity.referenceSessionRange.tradingDayId, "2026-08-07");
});

test("盘前缓存从 06:00 开始时，即使已到 09:30 也保持未完成", () => {
  const start = Date.UTC(2026, 7, 7, 10); // 06:00 EDT
  const bars = Array.from({ length: 42 }, (_, i) => ({
    time: start + i * 300_000, closeTime: start + (i + 1) * 300_000,
    open: 100, high: 105 + i, low: 95, close: 100,
  }));
  const range = findPremarketRange(bars, Date.UTC(2026, 7, 7, 14));
  assert.equal(range.dataComplete, false);
  assert.equal(range.completed, false);
  const liquidity = computeLiquidity([], [], [], null, Date.UTC(2026, 7, 7, 14), 150, bars, null, { symbol: "MUUSDT" });
  assert.equal(liquidity.buySide.some((x) => x.type === "PRE_MARKET_HIGH"), false);
});

test("EQH: 第二触点需等右侧 2 根 4H K 收盘后才生效", () => {
  const candles = Array.from({ length: 8 }, (_, i) => ({
    time: i * 1000,
    closeTime: i * 1000 + 999,
    open: 98,
    high: 99,
    low: 97,
    close: 98,
  }));
  candles[1].high = 100;
  candles[4].high = 100;
  candles[5].high = 101; // 第二触点后的右侧确认期，不能倒算成已扫损
  const swings = [
    { type: "HIGH", price: 100, index: 1, time: candles[1].time },
    { type: "HIGH", price: 100, index: 4, time: candles[4].time },
  ];

  const l = computeLiquidity([], [], swings, 0.002, now, 150, null, candles);
  const eqh = l.buySide.find((item) => item.type === "EQH");
  assert.equal(eqh.activeFrom, candles[6].closeTime);
  assert.equal(eqh.state, "ACTIVE");
});

test("V2.1 盘前区间：冬夏令时都按纽约 04:00-09:30，且排除 09:30 后 K", () => {
  const candle = (time, high) => ({ time, closeTime: time + 5 * 60_000, open: 100, high, low: 90, close: 100 });
  const summer = [
    candle(Date.UTC(2026, 7, 7, 8, 0), 101),   // 04:00 EDT
    candle(Date.UTC(2026, 7, 7, 13, 25), 105), // 09:25 EDT，最后一根盘前
    candle(Date.UTC(2026, 7, 7, 13, 30), 999), // 09:30 EDT，不得纳入
  ];
  const winter = [
    candle(Date.UTC(2026, 0, 7, 9, 0), 102),   // 04:00 EST
    candle(Date.UTC(2026, 0, 7, 14, 25), 106), // 09:25 EST
  ];
  assert.equal(findPremarketRange(summer, Date.UTC(2026, 7, 7, 14)).high, 105);
  assert.equal(findPremarketRange(winter, Date.UTC(2026, 0, 7, 15)).high, 106);
});

test("V2.1 盘前区间：忽略周末的同一纽约时段", () => {
  const candle = (time, high) => ({ time, closeTime: time + 5 * 60_000, open: 100, high, low: 90, close: 100 });
  const weekday = candle(Date.UTC(2026, 7, 7, 8), 103); // 周五 04:00 EDT
  const weekend = candle(Date.UTC(2026, 7, 8, 8), 999); // 周六 04:00 EDT
  const r = findPremarketRange([weekday, weekend], Date.UTC(2026, 7, 8, 14));
  assert.equal(r.date, "2026-08-07");
  assert.equal(r.high, 103);
});

test("V2.1 盘前流动性只对显式美股关联标的启用", () => {
  assert.equal(isEquityLinkedSymbol("MUUSDT"), true);
  assert.equal(isEquityLinkedSymbol("BTCUSDT"), false);
  const t = Date.UTC(2026, 7, 7, 8, 0);
  const intraday = [{ time: t, closeTime: t + 5 * 60_000, open: 100, high: 102, low: 98, close: 101 }];
  const btc = computeLiquidity([], [], [], 0.002, t + 60 * 60_000, 150, intraday, null, { symbol: "BTCUSDT" });
  assert.equal(btc.buySide.some((x) => x.type === "PRE_MARKET_HIGH"), false);
});

test("24×7 Crypto：Asia 20:00-00:00 ET 完成后才形成 ASIA_HIGH/LOW", () => {
  const start = Date.UTC(2026, 7, 7, 0, 0); // 2026-08-06 20:00 EDT
  const bars = Array.from({ length: 48 }, (_, i) => ({
    time: start + i * 5 * 60_000,
    closeTime: start + (i + 1) * 5 * 60_000,
    open: 100, high: i === 10 ? 108 : 104, low: i === 20 ? 92 : 96, close: 100,
  }));
  const partial = findAsiaRange(bars, start + 2 * 60 * 60_000);
  assert.equal(partial.completed, false);
  const complete = findAsiaRange(bars, start + 4 * 60 * 60_000);
  assert.equal(complete.completed, true);
  assert.equal(complete.tradingDayId, "2026-08-07");
  assert.equal(complete.high, 108);
  assert.equal(complete.low, 92);

  const before = computeLiquidity([], [], [], 0.002, start + 2 * 60 * 60_000, 150, bars, null, { symbol: "BTCUSDT" });
  assert.equal(before.buySide.some((x) => x.type === "ASIA_HIGH"), false);
  const after = computeLiquidity([], [], [], 0.002, start + 4 * 60 * 60_000, 150, bars, null, { symbol: "BTCUSDT" });
  assert.equal(after.buySide.find((x) => x.type === "ASIA_HIGH").price, 108);
  assert.equal(after.sellSide.find((x) => x.type === "ASIA_LOW").price, 92);
  assert.equal(after.sessionRange.name, "ASIA");
});

test("商品 24×5：周六晚伪 Asia 数据和周日午夜价不得成为流动性参考", () => {
  const start = Date.UTC(2026, 7, 16, 0, 0); // 周六 20:00 EDT
  const bars = Array.from({ length: 49 }, (_, i) => ({
    time: start + i * 5 * 60_000,
    closeTime: start + (i + 1) * 5 * 60_000,
    open: 100,
    high: i === 10 ? 108 : 104,
    low: i === 20 ? 92 : 96,
    close: 100,
  }));
  const now = start + 5 * 60 * 60_000;
  const commodity = computeLiquidity([], [], [], null, now, 150, bars, null, { symbol: "XAUUSDT" });
  assert.equal(commodity.buySide.some((x) => x.type === "ASIA_HIGH"), false);
  assert.equal(commodity.sellSide.some((x) => x.type === "ASIA_LOW"), false);
  assert.equal(commodity.sessionRange, null);
  assert.equal(commodity.referenceSessionRange, null);
  assert.deepEqual(commodity.referencePrices, {});

  const crypto = computeLiquidity([], [], [], null, now, 150, bars, null, { symbol: "BTCUSDT" });
  assert.equal(crypto.buySide.some((x) => x.type === "ASIA_HIGH"), true);
  assert.equal(crypto.referencePrices.newYorkMidnightOpen.type, "NEW_YORK_MIDNIGHT_OPEN");
});

test("Asia 缓存从 22:00 开始时，即使到午夜也不得标记完成", () => {
  const start = Date.UTC(2026, 7, 7, 2); // 08/06 22:00 EDT
  const bars = Array.from({ length: 24 }, (_, i) => ({
    time: start + i * 300_000, closeTime: start + (i + 1) * 300_000,
    open: 100, high: 105, low: 95 - i, close: 100,
  }));
  const range = findAsiaRange(bars, Date.UTC(2026, 7, 7, 5));
  assert.equal(range.dataComplete, false);
  assert.equal(range.completed, false);
  const liquidity = computeLiquidity([], [], [], null, Date.UTC(2026, 7, 7, 5), 150, bars, null, { symbol: "BTCUSDT" });
  assert.equal(liquidity.sellSide.some((x) => x.type === "ASIA_LOW"), false);
});

test("市场画像隔离：股票关联不注入 ASIA，Crypto 不注入 PRE_MARKET", () => {
  const asiaStart = Date.UTC(2026, 7, 7, 0, 0);
  const asia = Array.from({ length: 48 }, (_, i) => ({ time: asiaStart + i * 300_000, closeTime: asiaStart + (i + 1) * 300_000, high: 105, low: 95, close: 100 }));
  const equity = computeLiquidity([], [], [], 0.002, asiaStart + 4 * 3600_000, 150, asia, null, { symbol: "MUUSDT" });
  assert.equal(equity.buySide.some((x) => x.type === "ASIA_HIGH"), false);

  const preStart = Date.UTC(2026, 7, 7, 8, 0);
  const pre = Array.from({ length: 66 }, (_, i) => ({ time: preStart + i * 300_000, closeTime: preStart + (i + 1) * 300_000, high: 105, low: 95, close: 100 }));
  const crypto = computeLiquidity([], [], [], 0.002, preStart + 6 * 3600_000, 150, pre, null, { symbol: "BTCUSDT" });
  assert.equal(crypto.buySide.some((x) => x.type === "PRE_MARKET_HIGH"), false);
});

test("动态 Draw 不存在 PWH>PDH>盘前>EQH 的无条件固定顺序", () => {
  const l1 = {
    buySide: [
      { type: "PDH", price: 160 },
      { type: "PRE_MARKET_HIGH", price: 155 },
      { type: "EQH", price: 150 },
    ],
    sellSide: [],
  };
  const r1 = rankLiquidityTargets(structNoExt, l1, "BULLISH", 100);
  assert.equal(r1.primary.type, "EQH");
  assert.equal(r1.primary.priority, null);
  const l2 = {
    buySide: [
      { type: "PRE_MARKET_HIGH", price: 155 },
      { type: "EQH", price: 150 },
    ],
    sellSide: [],
  };
  const r2 = rankLiquidityTargets(structNoExt, l2, "BULLISH", 100);
  assert.equal(r2.primary.type, "EQH");
});

test("流动性状态：wick 收回=SWEPT，收盘穿越=BROKEN，未触及=ACTIVE", () => {
  const level = { price: 100 };
  assert.deepEqual(liquidityStateForLevel(level, true, [{ high: 99, close: 98, closeTime: 2 }], 1), { state: "ACTIVE" });
  assert.deepEqual(liquidityStateForLevel(level, true, [{ high: 101, close: 99, closeTime: 2 }], 1), { state: "SWEPT", sweptAt: 2 });
  assert.deepEqual(liquidityStateForLevel(level, true, [{ high: 102, close: 101, closeTime: 2 }], 1), { state: "BROKEN", brokenAt: 2 });
  assert.deepEqual(liquidityStateForLevel(level, true, [{ high: 101, close: 100, closeTime: 2 }], 1), { state: "BROKEN", brokenAt: 2 });
  assert.deepEqual(liquidityStateForLevel(level, false, [{ low: 99, close: 100, closeTime: 2 }], 1), { state: "BROKEN", brokenAt: 2 });
});

test("ERL/IRL：外部边界来自同一个 dealing range，FVG只进IRL、不进扫损池", () => {
  const candles = Array.from({ length: 8 }, (_, i) => ({ time: i, closeTime: i + 0.9, open: 100, high: 110, low: 90, close: 100 }));
  const base = {
    buySide: [{ type: "PWH", price: 130 }, { type: "PDH", price: 110 }],
    sellSide: [{ type: "PWL", price: 70 }, { type: "PDL", price: 90 }],
  };
  const range = { high: 120, low: 80, highIndex: 2, lowIndex: 1, rangeType: "IMPULSE_BULLISH" };
  const fvg = { type: "BULLISH_FVG", top: 106, bottom: 104, quality: "STRUCTURE", executable: true, status: "OPEN" };
  const result = applyDealingRangeLiquidity({ liquidity: base, range, swings: [{ type: "HIGH", price: 112, index: 3 }], fvgs: [fvg], candles, price: 100 });
  assert.equal(result.externalRange.high, 120);
  assert.equal(result.buySide.find((x) => x.type === "EXTERNAL_HIGH").rangeClass, "ERL");
  assert.equal(result.buySide.find((x) => x.type === "PDH").rangeClass, "IRL");
  assert.equal(result.buySide.some((x) => x.type === "INTERNAL_FVG"), false);
  assert.equal(result.internalRange.some((x) => x.type === "INTERNAL_FVG" && x.liquidityKind === "IMBALANCE"), true);
  assert.equal(result.primaryBuyDraw.type, "EXTERNAL_HIGH");
});

test("RECENT 观察区间不得生成 ERL/IRL 或 Range Draw", () => {
  const base = {
    buySide: [{ type: "PDH", price: 125 }],
    sellSide: [{ type: "PDL", price: 75 }],
  };
  const out = applyDealingRangeLiquidity({
    liquidity: base,
    range: { rangeType: "RECENT", high: 120, low: 80, equilibrium: 100 },
    swings: [{ type: "HIGH", price: 110, index: 2 }, { type: "LOW", price: 90, index: 3 }],
    price: 100,
  });
  assert.equal(out.externalRange, null);
  assert.deepEqual(out.internalRange, []);
  assert.equal(out.primaryBuyDraw, null);
  assert.equal(out.primarySellDraw, null);
  assert.equal(out.buySide.some((x) => x.type === "EXTERNAL_HIGH" || x.type === "INTERNAL_HIGH"), false);
  assert.equal(out.sellSide.some((x) => x.type === "EXTERNAL_LOW" || x.type === "INTERNAL_LOW"), false);
});

test("EQH 支持多个独立池，且每个池首尾都直接满足容差", () => {
  const clusters = findEqualHighClusters([
    { type: "HIGH", price: 100, index: 1 }, { type: "HIGH", price: 100.1, index: 2 },
    { type: "HIGH", price: 110, index: 3 }, { type: "HIGH", price: 110.1, index: 4 },
  ], 0.002);
  assert.equal(clusters.length, 2);
  assert.deepEqual(clusters.map((x) => x.touches), [2, 2]);
});

test("EQH/EQL 容差随4H波动率调整并限制上下界", () => {
  const calm = Array.from({ length: 15 }, (_, i) => ({ high: 100.1, low: 99.9, close: 100, time: i }));
  const volatile = Array.from({ length: 15 }, (_, i) => ({ high: 103, low: 97, close: 100, time: i }));
  assert.equal(resolveEqualLevelTolerance(calm), 0.0005);
  assert.equal(resolveEqualLevelTolerance(volatile), 0.003);
});

test("Draw 排名排除 SWEPT/BROKEN，只选择 ACTIVE 流动性", () => {
  const ranked = rankLiquidityTargets(
    {},
    {
      buySide: [
        { type: "PWH", price: 130, state: "BROKEN" },
        { type: "PDH", price: 120, state: "SWEPT" },
        { type: "EQH", price: 115, state: "ACTIVE" },
      ],
      sellSide: [],
    },
    "BULLISH",
    100
  );
  assert.equal(ranked.primary.type, "EQH");
  assert.deepEqual(ranked.alternatives, []);
});
