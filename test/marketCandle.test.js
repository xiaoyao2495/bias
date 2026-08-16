import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLiquidity } from "../indicators/liquidity.js";
import { HTF_LIQUIDITY_SOURCE, marketDayIdAt, resolveInstrumentProfile } from "../indicators/instrumentProfile.js";
import {
  aggregateRegularSessionCandles,
  findNewYorkMidnightOpen,
  selectHtfLiquidityCandles,
} from "../indicators/marketCandle.js";

const M5 = 5 * 60_000;

function sessionBars(startUtc, base, { count = 78 } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    time: startUtc + i * M5,
    closeTime: startUtc + (i + 1) * M5,
    open: base + i * 0.01,
    high: base + 2 + i * 0.01,
    low: base - 2 + i * 0.01,
    close: base + 1 + i * 0.01,
    volume: 1,
  }));
}

test("市场日与 ICT 时钟分离：Crypto 市场日是 UTC，美股市场日是纽约当地日期", () => {
  const time = Date.UTC(2026, 7, 7, 1); // 纽约仍是 08/06
  const crypto = resolveInstrumentProfile("BTCUSDT");
  const equity = resolveInstrumentProfile("MUUSDT");
  assert.equal(crypto.marketTimeZone, "UTC");
  assert.equal(crypto.ictTimeZone, "America/New_York");
  assert.equal(marketDayIdAt(time, crypto), "2026-08-07");
  assert.equal(marketDayIdAt(time, equity), "2026-08-06");
});

test("Crypto PD/PW 保留交易所 UTC K，不被纽约午夜重组", () => {
  const profile = resolveInstrumentProfile("BTCUSDT");
  const daily = [{ time: Date.UTC(2026, 7, 6), closeTime: Date.UTC(2026, 7, 7), high: 110, low: 90 }];
  const weekly = [{ time: Date.UTC(2026, 7, 3), closeTime: Date.UTC(2026, 7, 10), high: 120, low: 80 }];
  const selected = selectHtfLiquidityCandles({ daily, weekly, intraday: [], profile, now: Date.UTC(2026, 7, 8) });
  assert.equal(selected.source, HTF_LIQUIDITY_SOURCE.EXCHANGE_UTC);
  assert.equal(selected.daily, daily);
  assert.equal(selected.weekly, weekly);
});

test("美股关联：只聚合 09:30-16:00 ET，盘前极值不污染 PDH", () => {
  const profile = resolveInstrumentProfile("MUUSDT");
  const monday = sessionBars(Date.UTC(2026, 7, 3, 13, 30), 100); // 09:30 EDT
  const tuesday = sessionBars(Date.UTC(2026, 7, 4, 13, 30), 110);
  const premarket = [{
    time: Date.UTC(2026, 7, 4, 12), closeTime: Date.UTC(2026, 7, 4, 12, 5),
    open: 100, high: 999, low: 1, close: 100,
  }];
  const now = Date.UTC(2026, 7, 5, 14); // 周三 10:00 EDT
  const result = aggregateRegularSessionCandles([...monday, ...tuesday, ...premarket], profile, now);
  assert.equal(result.daily.length, 2);
  assert.equal(result.daily.at(-1).tradingDayId, "2026-08-04");
  assert.ok(result.daily.at(-1).high < 999);
  assert.equal(result.daily.at(-1).source, HTF_LIQUIDITY_SOURCE.REGULAR_SESSION);

  const nativeDaily = [{ time: Date.UTC(2026, 7, 4), closeTime: Date.UTC(2026, 7, 5), high: 999, low: 1 }];
  const liquidity = computeLiquidity(nativeDaily, [], [], null, now, 150, [...monday, ...tuesday, ...premarket], null, { profile });
  assert.equal(liquidity.buySide.find((x) => x.type === "PDH").price, result.daily.at(-1).high);
  assert.equal(liquidity.buySide.find((x) => x.type === "PDH").source, HTF_LIQUIDITY_SOURCE.REGULAR_SESSION);
  assert.notEqual(liquidity.buySide.find((x) => x.type === "PDH").price, 999);
});

test("美股关联：当前现金时段未结束时不能形成当日 PDH/PDL", () => {
  const profile = resolveInstrumentProfile("MUUSDT");
  const partial = sessionBars(Date.UTC(2026, 7, 5, 13, 30), 120, { count: 10 });
  const now = partial.at(-1).closeTime;
  const selected = aggregateRegularSessionCandles(partial, profile, now);
  assert.deepEqual(selected.daily, []);

  // 即使调用方同时传入了永续 24h 日线，也不能静默回退并伪造股票现金时段 PDH。
  const nativeDaily = [{ time: Date.UTC(2026, 7, 4), closeTime: Date.UTC(2026, 7, 5), high: 999, low: 1 }];
  const liquidity = computeLiquidity(nativeDaily, [], [], null, now, 150, partial, null, { profile });
  assert.equal(liquidity.buySide.some((x) => x.type === "PDH"), false);
  assert.equal(liquidity.htfLiquidityComplete, false);
});

test("美股关联：完整上一周现金时段聚合 PWH/PWL，当前周不提前生效", () => {
  const profile = resolveInstrumentProfile("MUUSDT");
  const starts = [3, 4, 5, 6, 7].map((day) => Date.UTC(2026, 7, day, 13, 30));
  const previousWeek = starts.flatMap((start, i) => sessionBars(start, 100 + i * 10));
  const currentMonday = sessionBars(Date.UTC(2026, 7, 10, 13, 30), 500);
  const now = Date.UTC(2026, 7, 11, 14);
  const result = aggregateRegularSessionCandles([...previousWeek, ...currentMonday], profile, now);
  assert.equal(result.weekly.length, 1);
  assert.equal(result.weekly[0].tradingWeekId, "2026-08-03");
  assert.ok(result.weekly[0].high < 500);
});

test("美股关联：缓存从周中开始时不把半周冒充 PWH/PWL", () => {
  const profile = resolveInstrumentProfile("MUUSDT");
  const partialWeek = [5, 6, 7]
    .flatMap((day, i) => sessionBars(Date.UTC(2026, 7, day, 13, 30), 100 + i * 10));
  const result = aggregateRegularSessionCandles(partialWeek, profile, Date.UTC(2026, 7, 10, 14));
  assert.equal(result.daily.length, 3);
  assert.deepEqual(result.weekly, []);
});

test("美股关联：周一现金数据从盘中开始时，周二至周五不得伪造完整周线", () => {
  const profile = resolveInstrumentProfile("MUUSDT");
  const mondayPartial = sessionBars(Date.UTC(2026, 7, 3, 14, 30), 100, { count: 66 }); // 10:30 EDT
  const rest = [4, 5, 6, 7]
    .flatMap((day, i) => sessionBars(Date.UTC(2026, 7, day, 13, 30), 200 + i * 10));
  const result = aggregateRegularSessionCandles([...mondayPartial, ...rest], profile, Date.UTC(2026, 7, 10, 14));
  assert.deepEqual(result.daily.map((x) => x.tradingDayId), ["2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07"]);
  assert.deepEqual(result.weekly, []);
});

test("美股关联：现金时段中间缺 K 时不产生该日或该周流动性", () => {
  const profile = resolveInstrumentProfile("MUUSDT");
  const week = [3, 4, 5, 6, 7]
    .flatMap((day, i) => sessionBars(Date.UTC(2026, 7, day, 13, 30), 100 + i * 10));
  const missingMidday = week.filter((k) => k.time !== Date.UTC(2026, 7, 5, 15));
  const result = aggregateRegularSessionCandles(missingMidday, profile, Date.UTC(2026, 7, 10, 14));
  assert.equal(result.daily.some((x) => x.tradingDayId === "2026-08-05"), false);
  assert.deepEqual(result.weekly, []);
});

test("现金时段聚合由 IANA 时区处理冬夏令时", () => {
  const profile = resolveInstrumentProfile("MUUSDT");
  const summer = sessionBars(Date.UTC(2026, 7, 3, 13, 30), 100); // 09:30 EDT
  const winter = sessionBars(Date.UTC(2026, 0, 5, 14, 30), 200); // 09:30 EST
  assert.equal(aggregateRegularSessionCandles(summer, profile, Date.UTC(2026, 7, 4)).daily.length, 1);
  assert.equal(aggregateRegularSessionCandles(winter, profile, Date.UTC(2026, 0, 6)).daily.length, 1);
});

test("港股关联：只聚合早盘和午盘现金时段，排除午休永续价格", () => {
  const profile = resolveInstrumentProfile("TENCENTUSDT", { TENCENTUSDT: "HK_EQUITY" });
  const morning = sessionBars(Date.UTC(2026, 7, 3, 1, 30), 100, { count: 30 }); // 09:30-12:00 HKT
  const lunch = sessionBars(Date.UTC(2026, 7, 3, 4), 900, { count: 12 }); // 12:00-13:00 HKT
  const afternoon = sessionBars(Date.UTC(2026, 7, 3, 5), 110, { count: 36 }); // 13:00-16:00 HKT
  const result = aggregateRegularSessionCandles([...morning, ...lunch, ...afternoon], profile, Date.UTC(2026, 7, 4));
  assert.equal(result.daily.length, 1);
  assert.ok(result.daily[0].high < 900);
  assert.equal(result.daily[0].bars, 66);
});

test("New York Midnight Open 是独立参考价，不进入 buySide/sellSide 扫损池", () => {
  const midnight = {
    time: Date.UTC(2026, 7, 7, 4), // 00:00 EDT
    closeTime: Date.UTC(2026, 7, 7, 4, 5),
    open: 101,
    high: 102,
    low: 100,
    close: 101.5,
  };
  const now = Date.UTC(2026, 7, 7, 5);
  const ref = findNewYorkMidnightOpen([midnight], now);
  assert.equal(ref.price, 101);
  assert.equal(ref.tradingDayId, "2026-08-07");
  assert.equal(ref.liquidity, false);

  const liquidity = computeLiquidity([], [], [], null, now, 150, [midnight], null, { symbol: "BTCUSDT" });
  assert.equal(liquidity.referencePrices.newYorkMidnightOpen.price, 101);
  assert.equal(liquidity.buySide.some((x) => x.type === "NEW_YORK_MIDNIGHT_OPEN"), false);
  assert.equal(liquidity.sellSide.some((x) => x.type === "NEW_YORK_MIDNIGHT_OPEN"), false);
});

test("全部日/周 K 都未收盘时不使用半成品兜底", () => {
  const now = Date.UTC(2026, 7, 7, 12);
  const unfinished = [{ time: now - 1000, closeTime: now + 1000, high: 110, low: 90 }];
  const liquidity = computeLiquidity(unfinished, unfinished, [], null, now, 150, [], null, { symbol: "BTCUSDT" });
  assert.equal(liquidity.buySide.some((x) => x.type === "PDH" || x.type === "PWH"), false);
  assert.equal(liquidity.sellSide.some((x) => x.type === "PDL" || x.type === "PWL"), false);
});
