/**
 * replayPipeline.js — 实盘/回放共用的“截至某时刻可见数据”构造器。
 *
 * 核心不变量：任何传给 analyzeBias 的 K 线都必须 closeTime <= analysisTime；
 * 价格取最近已收盘 5m，结构价取最近已收盘 4H，禁止未来函数和进行中 K 重绘。
 */

import { getHistory } from "../data/binance.js";
import { analyzeBias } from "./analyzeBias.js";
import { rebuildDealingRangeLifecycle } from "../indicators/dealingRangeLifecycle.js";
import { buildInternalLiquidityContext } from "../indicators/internalLiquidity.js";
import {
  marketDayIdAt,
  resolveInstrumentProfile,
  tradingDayIdAt,
} from "../indicators/instrumentProfile.js";
import { loadExchangeInfo } from "../monitor/newsCalendar.js";
import { marketNow } from "../utils/marketClock.js";

const M5_MS = 5 * 60_000;
const H1_MS = 60 * 60_000;
export const CRYPTO_M5_WINDOW = 1000;
export const EQUITY_M5_WINDOW = 3000;
export const H1_VOLUME_WINDOW = 720;
export const H1_SWING_WINDOW = 48;
/** 所有生产入口共用同一冷启动深度，保证 Range 生命周期身份/版本不因入口漂移。 */
export const REPLAY_HISTORY_COUNTS = Object.freeze({ h4: 5000, daily: 2000, weekly: 400 });

export function m5WindowForProfile(profile) {
  return profile?.regularSession ? EQUITY_M5_WINDOW : CRYPTO_M5_WINDOW;
}

/** 时间升序数组中只保留 cutoff 前已收盘的最后 limit 根。 */
export function sliceClosedWindow(candles, cutoff, limit = Infinity) {
  const rows = Array.isArray(candles) ? candles : [];
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (Number(rows[mid]?.closeTime) <= cutoff) lo = mid + 1;
    else hi = mid;
  }
  const end = lo;
  const start = Number.isFinite(limit) ? Math.max(0, end - Math.max(0, limit)) : 0;
  return rows.slice(start, end);
}

function countNeeded(earliestCutoff, intervalMs, lookbackBars, now = marketNow()) {
  const earliestNeeded = Number(earliestCutoff) - lookbackBars * intervalMs;
  const distance = Math.max(0, Number(now) - earliestNeeded);
  return Math.max(lookbackBars, Math.ceil(distance / intervalMs) + 4);
}

/**
 * 为单点回放或一段历史扫描加载足够日内历史。
 * getHistory 从当前时刻向前分页，因此历史回放越早，需要的 count 越大。
 */
export async function loadReplayHistory({
  symbol,
  earliestCutoff,
  exchangeInfo = null,
  instrumentProfile = null,
  h4Count = REPLAY_HISTORY_COUNTS.h4,
  dailyCount = REPLAY_HISTORY_COUNTS.daily,
  weeklyCount = REPLAY_HISTORY_COUNTS.weekly,
  now = marketNow(),
} = {}) {
  const info = exchangeInfo || await loadExchangeInfo();
  const profile = instrumentProfile || resolveInstrumentProfile(symbol, info);
  const m5Window = m5WindowForProfile(profile);
  const m5Count = countNeeded(earliestCutoff, M5_MS, m5Window, now);
  const h1Count = countNeeded(earliestCutoff, H1_MS, H1_VOLUME_WINDOW, now);
  const [h4, daily, weekly, m5, h1] = await Promise.all([
    getHistory(symbol, "4h", h4Count),
    getHistory(symbol, "1d", dailyCount),
    getHistory(symbol, "1w", weeklyCount),
    getHistory(symbol, "5m", m5Count),
    getHistory(symbol, "1h", h1Count),
  ]);
  return { symbol, exchangeInfo: info, instrumentProfile: profile, h4, daily, weekly, m5, h1 };
}

/** 构造与实盘 analyzeBias 调用语义一致的历史输入，但不执行分析。 */
export function buildReplayInput({
  symbol,
  cutoff,
  history,
  exchangeInfo = null,
  instrumentProfile = null,
  priorRange = null,
  rebuildRangeState = priorRange == null,
} = {}) {
  const profile = instrumentProfile || history?.instrumentProfile || resolveInstrumentProfile(symbol, exchangeInfo || history?.exchangeInfo || {});
  const candles = sliceClosedWindow(history?.h4, cutoff);
  if (!candles.length) throw new Error(`${symbol || "symbol"} 在 ${new Date(cutoff).toISOString()} 前无已收盘 4H 数据`);

  const last4h = candles.at(-1);
  const m5 = sliceClosedWindow(history?.m5, cutoff, m5WindowForProfile(profile));
  const last5m = m5.at(-1) || null;
  const analysisTime = last5m?.closeTime ?? last4h.closeTime;
  const price = last5m?.close ?? last4h.close;
  const h1 = sliceClosedWindow(history?.h1, analysisTime, H1_VOLUME_WINDOW);
  const h1Swing = history?.h1Swing
    ? sliceClosedWindow(history.h1Swing, analysisTime, H1_SWING_WINDOW)
    : h1.slice(-H1_SWING_WINDOW);
  const internalLiquidity = buildInternalLiquidityContext(h1Swing, price, analysisTime);
  const daily = sliceClosedWindow(history?.daily, analysisTime);
  const weekly = sliceClosedWindow(history?.weekly, analysisTime);
  const rangeRebuild = rebuildRangeState && !priorRange && candles.length > 1
    ? rebuildDealingRangeLifecycle({ candles, endIndex: candles.length - 2 })
    : null;
  const effectivePriorRange = priorRange || rangeRebuild?.range || null;

  const input = {
    symbol,
    instrumentProfile: profile,
    candles,
    daily,
    weekly,
    price,
    structurePrice: last4h.close,
    time: last4h.closeTime,
    analysisTime,
    h1,
    m5,
    priorRange: effectivePriorRange,
    internalSwing: internalLiquidity.internalSwing,
  };
  return {
    input,
    profile,
    internalLiquidity,
    rangeRebuild,
    priorRange: effectivePriorRange,
    cutoff,
    analysisTime,
    structureTime: last4h.closeTime,
    price,
    structurePrice: last4h.close,
    marketDayId: marketDayIdAt(analysisTime, profile),
    ictTradingDayId: tradingDayIdAt(analysisTime, profile),
  };
}

/** 构造输入并执行共用引擎。 */
export function analyzeReplayPoint(options) {
  const prepared = buildReplayInput(options);
  return { ...prepared, result: analyzeBias(prepared.input) };
}
