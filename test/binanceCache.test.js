/**
 * binanceCache.test.js — 缓存半成品 K 剔除（08/15 审计统一根因回归）
 *
 * 背景：缓存写盘时若在 K 进行中，其 OHLC 只是中间值；等它收盘后读回缓存，
 * 调用方 closeTime<=now 会把半成品当最终值用（幽灵内部摆动位 XAG/DOGE/CL/ZEC、
 * PDH 漂移 SNDK/BZ/XRP、5m 假收回 CL 09:40 的统一根因）。
 * filterStaleCandles 剔除这类"写盘时未收盘、读盘时已收盘"的半成品；
 * coversLastClosed 判定缓存是否缺最新一根已收盘 K（缺则强制重拉拿最终值）。
 * 进行中的 K（closeTime>now）必须保留——实时扫损检测要靠它判断"当前价已收回"。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { filterStaleCandles, coversLastClosed } from "../data/binance.js";

const M5 = 300_000;
const bar = (openTime, close) => ({ time: openTime, close, closeTime: openTime + M5 - 1 });
const t = (min) => Date.UTC(2026, 7, 15, 8, min, 0); // 当天 08:min 开盘的 5m K

test("filterStaleCandles：读盘时仍在进行中的 K 保留（实时扫损依赖）", () => {
  // 缓存写于 08:32（08:30 K 进行中）；08:33 读盘时该 K 仍未收盘
  const cached = [bar(t(25), 100), bar(t(30), 101)];
  const good = filterStaleCandles(cached, t(32), t(33));
  assert.deepEqual(good.map((k) => k.time), [t(25), t(30)]);
});

test("filterStaleCandles：已收盘的半成品剔除，最终 K 与进行中 K 保留", () => {
  // 缓存写于 08:32（08:30 K 半成品落盘）；08:35:30 读盘：08:30 已收盘但其缓存值仍是半成品 → 剔除；
  // 08:25（写盘前已收盘，最终值）保留；08:35（读盘时进行中）保留。
  const cached = [bar(t(25), 100), bar(t(30), 101), bar(t(35), 102)];
  const good = filterStaleCandles(cached, t(32), Date.UTC(2026, 7, 15, 8, 35, 30));
  assert.deepEqual(good.map((k) => k.time), [t(25), t(35)]);
});

test("filterStaleCandles：写盘前就收盘的历史 K 全部保留", () => {
  const cached = [bar(t(10), 90), bar(t(15), 95), bar(t(20), 99), bar(t(25), 100)];
  const good = filterStaleCandles(cached, t(36), Date.UTC(2026, 7, 15, 8, 40, 0));
  assert.equal(good.length, 4); // 全部 closeTime <= mtime，无剔除
});

test("coversLastClosed：缺最新已收盘 K → false（触发强制重拉）", () => {
  // 08:33:35 时最新已收盘 5m K 是 08:25（closeTime 08:29:59.999）；缓存只到 08:20 → 未覆盖
  const good = [bar(t(20), 100)];
  assert.equal(coversLastClosed(good, "5m", Date.UTC(2026, 7, 15, 8, 33, 35)), false);
});

test("coversLastClosed：含最新已收盘 K（含进行中 K）→ true", () => {
  // 08:33:35：08:25 已收盘、08:30 进行中，两者都在 → 覆盖
  const good = [bar(t(25), 100), bar(t(30), 101)];
  assert.equal(coversLastClosed(good, "5m", Date.UTC(2026, 7, 15, 8, 33, 35)), true);
});

test("coversLastClosed：边界整点（now=08:30:00.000）时 08:25 K 已收盘", () => {
  const good = [bar(t(25), 100)]; // closeTime 08:29:59.999
  assert.equal(coversLastClosed(good, "5m", Date.UTC(2026, 7, 15, 8, 30, 0)), true);
});

test("coversLastClosed：未知周期保守放行", () => {
  assert.equal(coversLastClosed([], "1min", Date.now()), true);
});

test("coversLastClosed：周线按 Binance 周一 UTC 开盘对齐", () => {
  const lastClosedWeek = { closeTime: Date.UTC(2026, 7, 9, 23, 59, 59, 999) };
  const friday = Date.UTC(2026, 7, 14, 12);
  assert.equal(coversLastClosed([lastClosedWeek], "1w", friday), true);
});
