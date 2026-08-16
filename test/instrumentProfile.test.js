import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HTF_LIQUIDITY_SOURCE,
  INSTRUMENT_KIND,
  SESSION_MODEL,
  isExecutionSessionForProfile,
  isLiquidityEventTimeForProfile,
  resolveInstrumentProfile,
  tradingDayIdAt,
} from "../indicators/instrumentProfile.js";

test("统一分类：股票、商品与 Crypto 使用独立市场画像", () => {
  const equity = resolveInstrumentProfile("MUUSDT", { MUUSDT: "EQUITY" });
  assert.equal(equity.kind, INSTRUMENT_KIND.EQUITY_LINKED);
  assert.equal(equity.htfLiquiditySource, HTF_LIQUIDITY_SOURCE.REGULAR_SESSION);
  assert.equal(equity.marketTimeZone, "America/New_York");
  assert.equal(resolveInstrumentProfile("MUUSDT", {}).kind, INSTRUMENT_KIND.EQUITY_LINKED);
  const crypto = resolveInstrumentProfile("BTCUSDT", { BTCUSDT: "COIN" });
  assert.equal(crypto.kind, INSTRUMENT_KIND.CRYPTO_24X7);
  assert.equal(crypto.htfLiquiditySource, HTF_LIQUIDITY_SOURCE.EXCHANGE_UTC);
  assert.equal(crypto.marketTimeZone, "UTC");
  assert.equal(crypto.ictTimeZone, "America/New_York");
  const commodity = resolveInstrumentProfile("XAUUSDT", { XAUUSDT: "COMMODITY" });
  assert.equal(commodity.kind, INSTRUMENT_KIND.COMMODITY_LINKED);
  assert.equal(commodity.sessionModel, SESSION_MODEL.COMMODITY_24X5);
  assert.equal(commodity.htfLiquiditySource, HTF_LIQUIDITY_SOURCE.EXCHANGE_UTC);
  assert.equal(resolveInstrumentProfile("CLUSDT", {}).kind, INSTRUMENT_KIND.COMMODITY_LINKED);
});

test("KR_EQUITY 不误套纽约现金开盘模型", () => {
  const p = resolveInstrumentProfile("SKHYNIXUSDT", { SKHYNIXUSDT: "KR_EQUITY" });
  assert.equal(p.sessionModel, SESSION_MODEL.KR_EQUITY);
  assert.deepEqual(p.executionSessions, []);
  assert.equal(resolveInstrumentProfile("KORUUSDT", { KORUUSDT: "EQUITY" }).sessionModel, SESSION_MODEL.KR_EQUITY);
});

test("HK_EQUITY 使用香港现金市场画像，不再落入 24×7 Crypto", () => {
  const p = resolveInstrumentProfile("TENCENTUSDT", { TENCENTUSDT: "HK_EQUITY" });
  assert.equal(p.kind, INSTRUMENT_KIND.EQUITY_LINKED);
  assert.equal(p.sessionModel, SESSION_MODEL.HK_EQUITY);
  assert.equal(p.marketTimeZone, "Asia/Hong_Kong");
  assert.equal(p.htfLiquiditySource, HTF_LIQUIDITY_SOURCE.REGULAR_SESSION);
  assert.deepEqual(p.executionSessions, []);
  assert.equal(tradingDayIdAt(Date.UTC(2026, 7, 7, 1), p), "2026-08-07"); // 香港 09:00
});

test("Crypto Asia 20:00 ET 以后归入次日交易日，午夜后保持同一 ID", () => {
  const p = resolveInstrumentProfile("BTCUSDT");
  assert.equal(tradingDayIdAt(Date.UTC(2026, 7, 7, 1), p), "2026-08-07"); // 08/06 21:00 EDT
  assert.equal(tradingDayIdAt(Date.UTC(2026, 7, 7, 5), p), "2026-08-07"); // 08/07 01:00 EDT
});

test("执行窗口分流：Crypto 可做 London/NY；US 股票只做 09:30-10:00 ET", () => {
  const crypto = resolveInstrumentProfile("BTCUSDT");
  assert.equal(isExecutionSessionForProfile(crypto, { name: "ASIA" }, Date.UTC(2026, 7, 7, 1)), false);
  assert.equal(isExecutionSessionForProfile(crypto, { name: "LONDON" }, Date.UTC(2026, 7, 7, 6)), true);
  assert.equal(isExecutionSessionForProfile(crypto, { name: "NEW_YORK" }, Date.UTC(2026, 7, 7, 12)), true);

  const equity = resolveInstrumentProfile("MUUSDT", { MUUSDT: "EQUITY" });
  assert.equal(isExecutionSessionForProfile(equity, { name: "NEW_YORK" }, Date.UTC(2026, 7, 7, 11, 30)), false); // 07:30 EDT
  assert.equal(isExecutionSessionForProfile(equity, { name: "NEW_YORK" }, Date.UTC(2026, 7, 7, 13, 45)), true); // 09:45 EDT
  assert.equal(isExecutionSessionForProfile(equity, { name: "NEW_YORK" }, Date.UTC(2026, 7, 8, 13, 45)), false); // Saturday
});

test("流动性事件门禁：股票服从现金时段，港股排除午休和周末", () => {
  const us = resolveInstrumentProfile("MUUSDT", { MUUSDT: "EQUITY" });
  assert.equal(isLiquidityEventTimeForProfile(us, Date.UTC(2026, 7, 7, 13, 25)), false); // Fri 09:25 EDT
  assert.equal(isLiquidityEventTimeForProfile(us, Date.UTC(2026, 7, 7, 13, 30)), true);  // Fri 09:30 EDT
  assert.equal(isLiquidityEventTimeForProfile(us, Date.UTC(2026, 7, 8, 14)), false);      // Saturday

  const hk = resolveInstrumentProfile("HK0700USDT", { HK0700USDT: "HK_EQUITY" });
  assert.equal(isLiquidityEventTimeForProfile(hk, Date.UTC(2026, 7, 7, 1, 45)), true);  // Fri 09:45 HKT
  assert.equal(isLiquidityEventTimeForProfile(hk, Date.UTC(2026, 7, 7, 4, 30)), false); // 午休
  assert.equal(isLiquidityEventTimeForProfile(hk, Date.UTC(2026, 7, 8, 1, 45)), false); // Saturday
});

test("商品 24×5 门禁：周末和每日维护时段关闭，周日18:00 ET后归入周一交易日", () => {
  const commodity = resolveInstrumentProfile("XAUUSDT", { XAUUSDT: "COMMODITY" });
  assert.equal(isLiquidityEventTimeForProfile(commodity, Date.UTC(2026, 7, 9, 20)), false);     // Sun 16:00 EDT
  assert.equal(isLiquidityEventTimeForProfile(commodity, Date.UTC(2026, 7, 9, 22, 30)), true); // Sun 18:30 EDT
  assert.equal(isLiquidityEventTimeForProfile(commodity, Date.UTC(2026, 7, 10, 21, 30)), false); // Mon 17:30 EDT
  assert.equal(isLiquidityEventTimeForProfile(commodity, Date.UTC(2026, 7, 10, 14)), true);      // Mon 10:00 EDT
  assert.equal(tradingDayIdAt(Date.UTC(2026, 7, 9, 22, 30), commodity), "2026-08-10");
});
