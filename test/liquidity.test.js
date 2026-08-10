/**
 * liquidity 单元测试：PDH/PDL、PWH/PWL、EQH/EQL
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLiquidity, findEqualHighs, findEqualLows, rankLiquidityTargets, findPremarketRange, liquidityStateForLevel } from "../indicators/liquidity.js";

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
    { type: "PWH", price: 60000, time: 0 },
    { type: "PDH", price: 50000, time: 0 },
  ]);
  assert.deepEqual(l.sellSide, [
    { type: "PDL", price: 48000, time: 0 },
    { type: "PWL", price: 52000, time: 0 },
  ]);
  // ICT 优先级：买侧 PWH > PDH，卖侧 PWL > PDL（time = 形成该位 K 线的开盘时间）
  assert.deepEqual(l.primaryBuyDraw, { type: "PWH", price: 60000, time: 0 });
  assert.deepEqual(l.primarySellDraw, { type: "PWL", price: 52000, time: 0 });
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

test("EQL: 同理，取聚类中的最低点", () => {
  const swings = [
    { type: "LOW", price: 90.1, index: 1, time: 1001 },
    { type: "LOW", price: 90.2, index: 2, time: 1002 },
    { type: "LOW", price: 90.3, index: 3, time: 1003 },
    { type: "LOW", price: 110, index: 4, time: 1004 },
  ];
  assert.deepEqual(findEqualLows(swings, 0.002), {
    price: 90.1,
    touches: 3,
    firstIndex: 1,
    lastIndex: 3,
    firstTime: 1001,
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

test("V1.5 Bullish: PWH > EQH > PDH（都在价格上方）→ 主 Draw = PWH，备选按近到远", () => {
  const liquidity = {
    buySide: [
      { type: "PWH", price: 190 },
      { type: "EQH", price: 185 },
      { type: "PDH", price: 170 },
    ],
    sellSide: [],
  };
  const r = rankLiquidityTargets(structNoExt, liquidity, "BULLISH", 150);
  assert.equal(r.primary.type, "PWH");
  assert.equal(r.primary.price, 190);
  assert.equal(r.primary.priority, 2);
  assert.ok(r.primary.reason.includes("Previous Week High"));
  // 备选从近到远（多头升序）：PDH 170 最近 → EQH 185
  assert.deepEqual(r.alternatives, [
    { type: "PDH", price: 170 },
    { type: "EQH", price: 185 },
  ]);
});

test("V1.5 Bearish: PWL < EQL < PDL（都在价格下方）→ 主 Draw = PWL，备选按近到远", () => {
  const liquidity = {
    buySide: [],
    sellSide: [
      { type: "PWL", price: 100 },
      { type: "EQL", price: 110 },
      { type: "PDL", price: 120 },
    ],
  };
  const r = rankLiquidityTargets({ ...structNoExt, direction: "BEARISH" }, liquidity, "BEARISH", 150);
  assert.equal(r.primary.type, "PWL");
  assert.equal(r.primary.priority, 2);
  // 备选从近到远（空头降序）：PDL 120 最近 → EQL 110 → PWL 100
  assert.deepEqual(r.alternatives, [
    { type: "PDL", price: 120 },
    { type: "EQL", price: 110 },
  ]);
});

test("V1.5 无任何目标 → primary 为 null（Draw = NONE）", () => {
  const liquidity = { buySide: [], sellSide: [] };
  const r = rankLiquidityTargets(structNoExt, liquidity, "BULLISH", 150);
  assert.equal(r.primary, null);
  assert.deepEqual(r.alternatives, []);
});

test("V1.5 External High 优先级最高：外部结构高点 > PWH", () => {
  const structure = {
    direction: "BULLISH",
    externalSwingHigh: 220, // 未突破的外部高点 → 首要 BSL 目标
    externalSwingLow: null,
    lastHigh: { type: "HIGH", price: 200, label: "HH" },
    lastLow: null,
  };
  const liquidity = { buySide: [{ type: "PWH", price: 190 }], sellSide: [] };
  const r = rankLiquidityTargets(structure, liquidity, "BULLISH", 150);
  assert.equal(r.primary.type, "EXTERNAL_HIGH");
  assert.equal(r.primary.price, 220);
  assert.equal(r.primary.priority, 1);
  assert.equal(r.alternatives[0].type, "PWH");
});

test("V1.5 已突破的方向侧目标被过滤（价格不在正确一侧）", () => {
  const structure = { direction: "BULLISH", externalSwingHigh: 100, externalSwingLow: null, lastHigh: null, lastLow: null };
  const liquidity = { buySide: [{ type: "PDH", price: 160 }], sellSide: [] };
  // external high 100 已在价格下方（不构成上方目标，被过滤），PDH 160 在上方
  const r = rankLiquidityTargets(structure, liquidity, "BULLISH", 150);
  assert.equal(r.primary.type, "PDH");
  assert.equal(r.primary.price, 160);
});

// ---- V2.0 盘前区间（PRE_MARKET_HIGH/LOW，ICT 2022 Asian Range 的美股对应物）----
// 美股盘前 = 北京 16:00-21:30（夏令时 EDT 4:00-9:30）；1H K open 在北京 16-21 点属于盘前

test("V2.0 findPremarketRange: 取最近盘前时段（北京 16-21 点）的最高/最低", () => {
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
  assert.equal(r.high, 102.5); // 最高 high
  assert.equal(r.low, 98); // 最低 low
  assert.equal(r.bars, 6);
  assert.equal(r.date, "2026-08-07");
  // 极值形成时间：high 在 i=5（北京 21:00），low 在 i=0（北京 16:00）——扫损消息精确到"几点形成"
  assert.equal(r.highTime, T0 + 5 * 3600_000);
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

test("V2.0 computeLiquidity: 传 h1 → buySide/sellSide 含 PRE_MARKET_HIGH/LOW", () => {
  const daily = [mkCandle(0, 50000, 48000, true)];
  const weekly = [mkCandle(0, 60000, 52000, true)];
  const T0 = Date.UTC(2026, 7, 7, 8, 0);
  const h1 = [0, 1, 2, 3, 4, 5].map((i) => ({
    time: T0 + i * 3600_000,
    open: 100,
    high: 102 + i * 0.1,
    low: 98 + i * 0.1,
    close: 101,
    closeTime: T0 + (i + 1) * 3600_000,
  }));
  const l = computeLiquidity(daily, weekly, [], 0.002, Date.UTC(2026, 7, 7, 14, 30), 150, h1);
  const pmh = l.buySide.find((t) => t.type === "PRE_MARKET_HIGH");
  const pml = l.sellSide.find((t) => t.type === "PRE_MARKET_LOW");
  assert.ok(pmh && pmh.price === 102.5);
  assert.ok(pml && pml.price === 98);
  // 形成时间：high 在 i=5（北京 21:00），low 在 i=0（北京 16:00）
  assert.equal(pmh.time, T0 + 5 * 3600_000);
  assert.equal(pml.time, T0);
});

test("V2.0 rankLiquidityTargets: 优先级 PWH > PDH > PRE_MARKET_HIGH > EQH", () => {
  // 无 PWH：PDH 优先于盘前高
  const l1 = {
    buySide: [
      { type: "PDH", price: 160 },
      { type: "PRE_MARKET_HIGH", price: 155 },
      { type: "EQH", price: 150 },
    ],
    sellSide: [],
  };
  const r1 = rankLiquidityTargets(structNoExt, l1, "BULLISH", 100);
  assert.equal(r1.primary.type, "PDH");
  assert.equal(r1.primary.priority, 3);
  // 无 PWH/PDH：盘前高优先于 EQH
  const l2 = {
    buySide: [
      { type: "PRE_MARKET_HIGH", price: 155 },
      { type: "EQH", price: 150 },
    ],
    sellSide: [],
  };
  const r2 = rankLiquidityTargets(structNoExt, l2, "BULLISH", 100);
  assert.equal(r2.primary.type, "PRE_MARKET_HIGH");
  assert.equal(r2.primary.priority, 4);
  assert.ok(r2.primary.reason.includes("Pre-market"));
});

test("流动性状态：wick 收回=SWEPT，收盘穿越=BROKEN，未触及=ACTIVE", () => {
  const level = { price: 100 };
  assert.deepEqual(liquidityStateForLevel(level, true, [{ high: 99, close: 98, closeTime: 2 }], 1), { state: "ACTIVE" });
  assert.deepEqual(liquidityStateForLevel(level, true, [{ high: 101, close: 99, closeTime: 2 }], 1), { state: "SWEPT", sweptAt: 2 });
  assert.deepEqual(liquidityStateForLevel(level, true, [{ high: 102, close: 101, closeTime: 2 }], 1), { state: "BROKEN", brokenAt: 2 });
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
