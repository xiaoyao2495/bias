/**
 * liquidity.js — ICT 2022 流动性模型
 *
 * 输出：
 *   {
 *     buySide:  [{ type: "PDH"|"PWH"|"PRE_MARKET_HIGH"|"EQH", price, time?, date?, touches?, firstIndex?, lastIndex?, firstTime?, lastTime? }...], // 上方（买方）流动性，按价格从高到低
 *     sellSide: [{ type: "PDL"|"PWL"|"PRE_MARKET_LOW"|"EQL", price, time?, date?, touches?, firstIndex?, lastIndex?, firstTime?, lastTime? }...], // 下方（卖方）流动性，按价格从低到高
 *     internalRange: [...], // dealing range 内部的 stop liquidity 与 FVG/imbalance
 *     externalRange: { high, low }, // dealing range 两端外侧的 stops（ERL）
 *     primaryBuyDraw / primarySellDraw: 动态上下文评分结果（只在 range/price 已知后生成）
 *   }
 *
 * 形成时间字段（扫损消息"被扫的流动性是什么时候的"用，用户要对照图表定位该位）：
 *   time  — 形成 K 的开盘时间（ms）：PDH/PDL=昨日日 K、PWH/PWL=上周周 K、EQH/EQL=首个触点 4H K、
 *           EXTERNAL=外部 swing 4H K、PRE_MARKET=盘前区间形成极值的那根日内 K
 *   date  — 盘前区间（PRE_MARKET_HIGH/LOW）的纽约交易日 "YYYY-MM-DD"（无 highTime/lowTime 的兜底）
 *   firstTime/lastTime — EQH/EQL 首个/最后触点的 4H K 开盘时间
 *
 * EQH / EQL：两个以上接近的 Swing High / Low（误差默认 0.2%）视为等高点。
 *   只统计近端 swing（默认最近 150 根 4H ≈ 25 天），避免把历史价位区间的
 *   摆动点聚出"远高于现价"的假等低点（Case Replay 审计发现）。
 *   额外记录形成时间信息：touches（触点数量）、firstIndex / lastIndex（在 4H K 线中的位置），
 *   因为 ICT 流动性中"时间"很重要（越近的等高点越有效）。
 *
 * V2.1 盘前区间（PRE_MARKET_HIGH/LOW）：仅用于显式识别的美股关联合约。
 *   用 America/New_York 当地 04:00-09:30 + 5m K 计算，DST 由 IANA 时区处理；
 *   它是美股盘前流动性，不再称为 ICT Asian Range。
 */

import { marketNow } from "../utils/marketClock.js";
import { addIsoDays, isLiquidityEventTimeForProfile, resolveInstrumentProfile, SESSION_MODEL, nyClockAt, tradingDayIdAt } from "./instrumentProfile.js";
import { exchangeUtcDayId, findNewYorkMidnightOpen, selectHtfLiquidityCandles } from "./marketCandle.js";

const HTF_SWING_RIGHT = 2;

function continuousCandles(candles) {
  const sorted = [...(candles || [])].sort((a, b) => a.time - b.time);
  return sorted.every((k, index) => {
    if (index === 0) return true;
    const gap = Number(k.time) - Number(sorted[index - 1].closeTime);
    return Number.isFinite(gap) && gap >= 0 && gap <= 1;
  });
}

function candleEndClock(k) {
  // Binance closeTime 是下一个边界前 1ms；测试/其他数据源可能直接使用边界时间。
  // +1ms 后取时钟可让两种表示统一为半开区间的结束边界。
  return nyClockAt(Number(k?.closeTime) + 1);
}

const EQ_TOLERANCE = 0.002; // 无可用波动率数据时的兼容回退值
const EQ_LOOKBACK_BARS = 150; // EQH/EQL 只统计最近 150 根 4H K 线的 swing（≈25 天）
const EQ_TOLERANCE_MIN = 0.0005;
const EQ_TOLERANCE_MAX = 0.003;

// V1.5：目标类型的人类可读 reason
const TYPE_REASON = {
  PWH: "Previous Week High (HTF objective)",
  PDH: "Previous Day High",
  PRE_MARKET_HIGH: "Pre-market High (session liquidity)",
  ASIA_HIGH: "Asia Range High (session liquidity)",
  EQH: "Equal Highs (liquidity cluster)",
  PWL: "Previous Week Low (HTF objective)",
  PDL: "Previous Day Low",
  PRE_MARKET_LOW: "Pre-market Low (session liquidity)",
  ASIA_LOW: "Asia Range Low (session liquidity)",
  EQL: "Equal Lows (liquidity cluster)",
};

/**
 * Draw on Liquidity 不是课程中的固定类型优先级。这里按当前 dealing range、距离、
 * 未消费状态、同价位汇聚和 FVG 质量做可审计评分。structure 参数只为兼容旧调用方保留，
 * 不再使用 structure.externalSwingHigh/Low 冒充 ERL。
 */
export function rankLiquidityTargets(structure, liquidity, direction, price) {
  const isBuy = direction === "BULLISH";
  const inSide = (p) => price == null || (isBuy ? p > price : p < price);
  const active = (x) => !x || !x.state || x.state === "ACTIVE";
  if (!liquidity || (direction !== "BULLISH" && direction !== "BEARISH")) return { primary: null, alternatives: [] };
  const stops = (isBuy ? liquidity.buySide : liquidity.sellSide).filter((x) => Number.isFinite(x?.price) && inSide(x.price) && active(x));
  const imbalances = (liquidity.internalRange || []).filter((x) =>
    x?.liquidityKind === "IMBALANCE" && x.executable !== false && Number.isFinite(x.price) && inSide(x.price));
  const rangeSpan = Number(liquidity.externalRange?.high) - Number(liquidity.externalRange?.low);
  const maxDistance = price == null ? 0 : Math.max(0, ...stops.map((x) => Math.abs(x.price - price)));
  const span = Number.isFinite(rangeSpan) && rangeSpan > 0
    ? rangeSpan
    : Math.max(maxDistance, Math.abs(Number(price)) * 0.01, 1e-9);
  const newest = Math.max(0, ...stops.map((x) => Number(x.activeFrom ?? x.lastTime ?? x.time) || 0));
  const typeWeight = {
    EXTERNAL_HIGH: 18, EXTERNAL_LOW: 18,
    EQH: 18, EQL: 18,
    PWH: 15, PWL: 15,
    PDH: 13, PDL: 13,
    PRE_MARKET_HIGH: 10, PRE_MARKET_LOW: 10,
    ASIA_HIGH: 10, ASIA_LOW: 10,
    INTERNAL_HIGH: 8, INTERNAL_LOW: 8,
    INTERNAL_FVG: 10,
  };
  const raw = [...stops, ...imbalances].map((x) => {
    const distance = price == null ? 0 : Math.abs(x.price - price);
    const distanceScore = price == null ? 0 : Math.max(0, 25 - 20 * distance / span);
    const rangeScore = x.rangeClass === "ERL" ? 25 : x.rangeClass === "IRL" ? 12 : 4;
    const qualityScore = x.quality === "STRUCTURE" ? 12 : x.quality === "DISPLACEMENT" ? 8 : 0;
    const recency = Number(x.activeFrom ?? x.lastTime ?? x.time) || 0;
    const recencyScore = newest && recency === newest ? 5 : 0;
    const confluence = stops.filter((other) => other !== x && Math.abs(other.price - x.price) / Math.max(Math.abs(x.price), 1e-9) <= 0.0005).length;
    const score = rangeScore + (typeWeight[x.type] || 5) + distanceScore + qualityScore + Math.min(12, confluence * 6);
    return {
      ...x,
      score: Math.round((score + recencyScore) * 100) / 100,
      priority: null,
      reason: x.reason || TYPE_REASON[x.type] || (x.liquidityKind === "IMBALANCE" ? "Internal range imbalance (FVG)" : "Range liquidity"),
      distance,
    };
  });
  raw.sort((a, b) => b.score - a.score || a.distance - b.distance || (isBuy ? a.price - b.price : b.price - a.price));
  const primary = raw[0] || null;
  const alternatives = raw.slice(1)
    .sort((a, b) => (isBuy ? a.price - b.price : b.price - a.price))
    .map(({ type, price: targetPrice, group, rangeClass, liquidityKind, score, top, bottom }) => ({
      type, price: targetPrice, ...(group ? { group } : {}), ...(rangeClass ? { rangeClass } : {}),
      ...(liquidityKind ? { liquidityKind } : {}), score, ...(top != null ? { top } : {}), ...(bottom != null ? { bottom } : {}),
    }));
  return { primary, alternatives };
}

/**
 * 把所有流动性来源绑定到同一个 dealing range：
 * - ERL：range high/low 外侧的 stops；
 * - IRL：range 内部的短期 swing stops 与 FVG/imbalance。
 * FVG 单独放 internalRange，绝不送进 sweep 检测（缺口不是 stop pool）。
 */
export function applyDealingRangeLiquidity({ liquidity, range, swings = [], fvgs = [], candles = [], price = null } = {}) {
  const base = liquidity || { buySide: [], sellSide: [] };
  const high = Number(range?.high);
  const low = Number(range?.low);
  if (!range || range.rangeType === "RECENT" || range.rangeType === "NONE"
    || !Number.isFinite(high) || !Number.isFinite(low) || !(high > low)) {
    return { ...base, externalRange: null, internalRange: [], primaryBuyDraw: null, primarySellDraw: null };
  }
  const confirmedAt = (index, fallback) => candleCloseAt(candles, index != null ? index + HTF_SWING_RIGHT : null) ?? fallback ?? null;
  const classifyStop = (level, isBuy) => ({
    ...level,
    ...(range.rangeId ? { rangeId: range.rangeId } : {}),
    liquidityKind: "STOPS",
    rangeClass: isBuy ? (level.price >= high ? "ERL" : level.price > low ? "IRL" : "OUTSIDE")
      : (level.price <= low ? "ERL" : level.price < high ? "IRL" : "OUTSIDE"),
  });
  const buySide = (base.buySide || []).map((level) => classifyStop(level, true));
  const sellSide = (base.sellSide || []).map((level) => classifyStop(level, false));

  const rangeHigh = classifyStop({
    type: "EXTERNAL_HIGH", price: high, group: "RANGE", source: "DEALING_RANGE",
    time: range.highTime ?? undefined, activeFrom: range.highConfirmedAt ?? confirmedAt(range.highIndex, range.highTime),
    reason: "Dealing range high (external buy-side liquidity)",
  }, true);
  const rangeLow = classifyStop({
    type: "EXTERNAL_LOW", price: low, group: "RANGE", source: "DEALING_RANGE",
    time: range.lowTime ?? undefined, activeFrom: range.lowConfirmedAt ?? confirmedAt(range.lowIndex, range.lowTime),
    reason: "Dealing range low (external sell-side liquidity)",
  }, false);
  const pushUnique = (list, level) => {
    const duplicate = list.some((x) => x.type === level.type && Math.abs(x.price - level.price) / Math.max(Math.abs(level.price), 1e-9) <= 1e-8);
    if (!duplicate) list.push(level);
  };
  pushUnique(buySide, rangeHigh);
  pushUnique(sellSide, rangeLow);

  // 内部 swing 只取 range 内最近一批已确认 pivot；保留多个池，而不是只留“最近一个”。
  const internalStops = [...(swings || [])]
    .filter((s) => Number.isFinite(s?.price) && s.price > low && s.price < high)
    .sort((a, b) => Number(b.index ?? 0) - Number(a.index ?? 0))
    .slice(0, 12)
    .map((s) => {
      const isBuy = s.type === "HIGH";
      return classifyStop({
        type: isBuy ? "INTERNAL_HIGH" : "INTERNAL_LOW",
        price: s.price,
        group: "SWING",
        source: "DEALING_RANGE_INTERNAL_SWING",
        time: s.time,
        activeFrom: confirmedAt(s.index, s.time),
        reason: isBuy ? "Internal range short-term high" : "Internal range short-term low",
      }, isBuy);
    });
  for (const level of internalStops) pushUnique(level.type === "INTERNAL_HIGH" ? buySide : sellSide, level);

  if (candles.length) {
    annotateLiquidityStates(buySide, true, candles);
    annotateLiquidityStates(sellSide, false, candles);
  }
  buySide.sort((a, b) => b.price - a.price);
  sellSide.sort((a, b) => a.price - b.price);

  const internalRange = [
    ...buySide.filter((x) => x.rangeClass === "IRL"),
    ...sellSide.filter((x) => x.rangeClass === "IRL"),
    ...(fvgs || [])
      .filter((fvg) => {
        const mid = (Number(fvg?.top) + Number(fvg?.bottom)) / 2;
        return Number.isFinite(mid) && mid > low && mid < high && (fvg.executionStatus || fvg.status) !== "FILLED";
      })
      .map((fvg) => ({
        ...fvg,
        type: "INTERNAL_FVG",
        sourceType: fvg.type,
        price: (fvg.top + fvg.bottom) / 2,
        rangeClass: "IRL",
        liquidityKind: "IMBALANCE",
        ...(range.rangeId ? { rangeId: range.rangeId } : {}),
        group: "PD_ARRAY",
        reason: "Internal range imbalance (FVG/CE)",
      })),
  ];
  const enriched = {
    ...base,
    buySide,
    sellSide,
    externalRange: { high, low, rangeType: range.rangeType, rangeId: range.rangeId ?? null, highLevel: rangeHigh, lowLevel: rangeLow },
    internalRange,
  };
  enriched.primaryBuyDraw = rankLiquidityTargets(null, enriched, "BULLISH", price).primary;
  enriched.primarySellDraw = rankLiquidityTargets(null, enriched, "BEARISH", price).primary;
  return enriched;
}

/** 最近已收盘的一根 K（closeTime <= now）；now 默认当前时间，回放时可注入历史时间 */
function lastCompleted(candles, now = marketNow()) {
  if (!candles || candles.length === 0) return null;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].closeTime && candles[i].closeTime <= now) return candles[i];
  }
  // 课程价位必须来自完整周期；全部未收盘时宁可缺失，不能拿半成品伪造 PD/PW。
  return null;
}

/**
 * V2.1 美股盘前区间：纽约当地 04:00-09:30，自动处理 EST/EDT。
 *
 * 取 now 之前最近一个含已收盘盘前 K 的纽约交易日。使用 5m 可精确包含最后 09:25-09:30；
 * 更粗 K 线只有在整根完全位于盘前窗口内时才纳入，避免把 09:30 后行情混入。
 * @param {Array} [intraday] 日内 K 线（推荐 5m）
 * @param {number} [now] 参考时间（ms），默认当前时间
 * @returns {{ high:number, low:number, date:string, bars:number, highTime:number, lowTime:number, activeFrom:number }|null}
 *   highTime/lowTime：盘前区间内形成最高/最低的那根日内 K 的开盘时间，
 *   供扫损消息精确展示"这个盘前位是几点形成的"（仅日期用户在图上找不到）
 */
export function findPremarketRange(intraday, now = marketNow()) {
  if (!intraday || !intraday.length) return null;
  const etParts = (ms) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
      hourCycle: "h23", hour: "2-digit", minute: "2-digit",
    }).formatToParts(new Date(ms));
    const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday, minute: Number(p.hour) * 60 + Number(p.minute) };
  };
  const inWindow = (k) => {
    if (k.time == null || k.closeTime == null) return false;
    const open = etParts(k.time);
    const close = etParts(k.closeTime);
    return !["Sat", "Sun"].includes(open.weekday) && open.date === close.date && open.minute >= 4 * 60 && open.minute < 9 * 60 + 30 && close.minute <= 9 * 60 + 30;
  };

  const closed = intraday.filter((k) => k.closeTime && k.closeTime <= now);
  if (!closed.length) return null;

  // 最近一个盘前时段：从末尾往前找第一根落在盘前窗口的 K 的纽约交易日
  let date = null;
  for (let i = closed.length - 1; i >= 0; i--) {
    if (inWindow(closed[i])) {
      date = etParts(closed[i].time).date;
      break;
    }
  }
  if (!date) return null;

  const ks = closed.filter((k) => etParts(k.time).date === date && inWindow(k));
  if (!ks.length) return null;
  ks.sort((a, b) => a.time - b.time);
  const firstClock = nyClockAt(ks[0].time);
  const lastEndClock = candleEndClock(ks.at(-1));
  const dataComplete = firstClock?.date === date && firstClock.minute === 4 * 60
    && lastEndClock?.date === date && lastEndClock.minute >= 9 * 60 + 30
    && continuousCandles(ks);
  const high = Math.max(...ks.map((k) => k.high));
  const low = Math.min(...ks.map((k) => k.low));
  if (high === low) return null; // 盘前无波动 → 不构成区间
  // 取形成极值的那根日内 K（并列时取最近一根）：扫损消息要精确到"几点形成"
  const highK = [...ks].reverse().find((k) => k.high === high);
  const lowK = [...ks].reverse().find((k) => k.low === low);
  return {
    high,
    low,
    date,
    tradingDayId: date,
    completed: dataComplete && (() => {
      const clock = nyClockAt(now);
      return !!clock && (clock.date > date || (clock.date === date && clock.minute >= 9 * 60 + 30));
    })(),
    dataComplete,
    bars: ks.length,
    highTime: highK ? highK.time : null,
    lowTime: lowK ? lowK.time : null,
    activeFrom: Math.max(...ks.map((k) => k.closeTime || k.time)),
  };
}

/** 兼容旧调用；实际分类统一委托 instrumentProfile，避免模块间白名单漂移。 */
export function isEquityLinkedSymbol(symbol, exchangeInfo = {}) {
  return resolveInstrumentProfile(symbol, exchangeInfo).kind === "EQUITY_LINKED";
}

/**
 * @param {Array} dailyKlines  日 K 线（data/binance.js 输出）
 * @param {Array} weeklyKlines 周 K 线
 * @param {Array} swings        4H 摆动点（findSwings 输出，时间升序）
 * @param {number} tolerance    等高点容差（0.2% 默认）
 * @param {number} now          参考时间（ms）。回放时传历史时间，只认该时间前已收盘的日/周 K
 * @param {number} eqLookbackBars EQH/EQL 回看窗口（根 4H K 线，默认 150）
 * @param {Array} [intradayKlines] 日内 K（推荐 5m）：仅美股关联标的计算盘前区间
 * @param {Array} [referenceCandles] 已收盘 4H K，用于标记流动性 ACTIVE/SWEPT/BROKEN
 * @param {Object} [options] { symbol, profile, exchangeInfo }；profile 为统一市场画像
 */
export function computeLiquidity(dailyKlines, weeklyKlines, swings, tolerance = null, now = marketNow(), eqLookbackBars = EQ_LOOKBACK_BARS, intradayKlines = null, referenceCandles = null, options = {}) {
  const buySide = [];
  const sellSide = [];

  const profile = options.profile || resolveInstrumentProfile(options.symbol, options.exchangeInfo);
  const htfCandles = selectHtfLiquidityCandles({
    daily: dailyKlines,
    weekly: weeklyKlines,
    intraday: intradayKlines,
    profile,
    now,
  });

  const prevDay = lastCompleted(htfCandles.daily, now);
  if (prevDay) {
    const common = {
      group: "HTF",
      source: prevDay.source || htfCandles.source,
      sessionModel: profile.sessionModel,
      tradingDayId: prevDay.tradingDayId || exchangeUtcDayId(prevDay, profile),
      activeFrom: prevDay.closeTime,
    };
    buySide.push({ type: "PDH", price: prevDay.high, time: prevDay.highTime ?? prevDay.time, ...common });
    sellSide.push({ type: "PDL", price: prevDay.low, time: prevDay.lowTime ?? prevDay.time, ...common });
  }

  const prevWeek = lastCompleted(htfCandles.weekly, now);
  if (prevWeek) {
    const tradingWeekId = prevWeek.tradingWeekId || prevWeek.periodId || null;
    const common = {
      group: "HTF",
      source: prevWeek.source || htfCandles.source,
      sessionModel: profile.sessionModel,
      ...(tradingWeekId ? { tradingWeekId } : {}),
      activeFrom: prevWeek.closeTime,
    };
    buySide.push({ type: "PWH", price: prevWeek.high, time: prevWeek.highTime ?? prevWeek.time, ...common });
    sellSide.push({ type: "PWL", price: prevWeek.low, time: prevWeek.lowTime ?? prevWeek.time, ...common });
  }

  // 市场画像只改变 Session 流动性来源，不改变 PDH/PDL、EQH/EQL 等 ICT 定义。
  // US 股票关联：04:00-09:30 ET 盘前区间；Crypto/商品：20:00-00:00 ET Asia Range。
  // 形成中的区间高低会重绘，必须等 Session 结束后才注入可扫流动性池。
  const premkt = profile.sessionModel === SESSION_MODEL.US_EQUITY ? findPremarketRange(intradayKlines, now) : null;
  const usesAsiaSession = profile.sessionModel === SESSION_MODEL.CRYPTO_24X7
    || profile.sessionModel === SESSION_MODEL.COMMODITY_24X5;
  const sessionTimeAllowed = profile.sessionModel === SESSION_MODEL.COMMODITY_24X5
    ? (time) => isLiquidityEventTimeForProfile(profile, time)
    : null;
  const asia = usesAsiaSession ? findAsiaRange(intradayKlines, now, { eventTimeAllowed: sessionTimeAllowed }) : null;
  const midnightCandidate = usesAsiaSession ? findNewYorkMidnightOpen(intradayKlines, now) : null;
  const midnightOpen = midnightCandidate && (!sessionTimeAllowed || sessionTimeAllowed(midnightCandidate.time))
    ? midnightCandidate
    : null;
  if (premkt) {
    if (premkt.completed) {
      buySide.push({ type: "PRE_MARKET_HIGH", price: premkt.high, date: premkt.date, tradingDayId: premkt.tradingDayId, time: premkt.highTime, group: "SESSION", ...(referenceCandles ? { activeFrom: premkt.activeFrom } : {}) });
      sellSide.push({ type: "PRE_MARKET_LOW", price: premkt.low, date: premkt.date, tradingDayId: premkt.tradingDayId, time: premkt.lowTime, group: "SESSION", ...(referenceCandles ? { activeFrom: premkt.activeFrom } : {}) });
    }
  }
  if (asia?.completed) {
    buySide.push({ type: "ASIA_HIGH", price: asia.high, date: asia.date, tradingDayId: asia.tradingDayId, time: asia.highTime, group: "SESSION", ...(referenceCandles ? { activeFrom: asia.activeFrom } : {}) });
    sellSide.push({ type: "ASIA_LOW", price: asia.low, date: asia.date, tradingDayId: asia.tradingDayId, time: asia.lowTime, group: "SESSION", ...(referenceCandles ? { activeFrom: asia.activeFrom } : {}) });
  }

  // EQH/EQL 只取近端 swing（按 4H K 线 index 回看）
  const maxIdx = swings.length ? swings[swings.length - 1].index : 0;
  const recentSwings = swings.filter((s) => s.index >= maxIdx - eqLookbackBars + 1);

  const effectiveTolerance = resolveEqualLevelTolerance(referenceCandles, tolerance);
  for (const eqh of findEqualHighClusters(recentSwings, effectiveTolerance)) {
    buySide.push({ type: "EQH", group: "HTF", ...eqh, tolerance: effectiveTolerance, ...(referenceCandles ? { activeFrom: candleCloseAt(referenceCandles, eqh.formedIndex + HTF_SWING_RIGHT) ?? candleCloseAt(referenceCandles, eqh.formedIndex) ?? eqh.formedTime } : {}) });
  }
  for (const eql of findEqualLowClusters(recentSwings, effectiveTolerance)) {
    sellSide.push({ type: "EQL", group: "HTF", ...eql, tolerance: effectiveTolerance, ...(referenceCandles ? { activeFrom: candleCloseAt(referenceCandles, eql.formedIndex + HTF_SWING_RIGHT) ?? candleCloseAt(referenceCandles, eql.formedIndex) ?? eql.formedTime } : {}) });
  }

  if (referenceCandles) {
    annotateLiquidityStates(buySide, true, referenceCandles);
    annotateLiquidityStates(sellSide, false, referenceCandles);
  }

  buySide.sort((a, b) => b.price - a.price); // 上方目标：最高的排最前
  sellSide.sort((a, b) => a.price - b.price); // 下方目标：最低的排最前

  const completedSessionRange = premkt?.completed
    ? { ...premkt, name: "PRE_MARKET" }
    : asia?.completed
      ? { ...asia, name: "ASIA" }
      : null;
  const currentTradingDayId = tradingDayIdAt(now, profile);
  const currentSessionRange = completedSessionRange?.tradingDayId === currentTradingDayId
    ? completedSessionRange
    : null;
  return {
    buySide,
    sellSide,
    // range 与 price 尚未知，不能在这里伪造一个“课程固定主目标”；analyzeBias 在绑定
    // dealing range 后通过动态评分填充这两个兼容字段。
    primaryBuyDraw: null,
    primarySellDraw: null,
    equalLevelTolerance: effectiveTolerance,
    instrumentProfile: profile,
    htfLiquiditySource: htfCandles.source,
    htfLiquidityComplete: htfCandles.complete,
    referencePrices: midnightOpen ? { newYorkMidnightOpen: midnightOpen } : {},
    sessionRange: currentSessionRange,
    referenceSessionRange: completedSessionRange && !currentSessionRange ? completedSessionRange : null,
  };
}

/**
 * Crypto/商品合约的 ICT Asia Range：纽约当地 20:00-00:00，归入次日交易日。
 * 只返回最近一个有数据的 Session；completed=false 时表示区间仍在形成，不得作为可扫池。
 */
export function findAsiaRange(intraday, now = marketNow(), { eventTimeAllowed = null } = {}) {
  if (!intraday || !intraday.length) return null;
  const closed = intraday.filter((k) => k?.time != null
    && k?.closeTime != null
    && k.closeTime <= now
    && (!eventTimeAllowed || eventTimeAllowed(k.time)));
  const rows = [];
  for (const k of closed) {
    const open = nyClockAt(k.time);
    const close = nyClockAt(k.closeTime);
    if (!open || !close || open.minute < 20 * 60) continue;
    const tradingDayId = addIsoDays(open.date, 1);
    const closeInside = close.date === open.date
      ? close.minute > open.minute && close.minute <= 24 * 60
      : close.date === tradingDayId && close.minute === 0;
    if (!closeInside) continue;
    rows.push({ k, open, tradingDayId });
  }
  if (!rows.length) return null;
  const latest = rows.reduce((best, row) => !best || row.k.closeTime > best.k.closeTime ? row : best, null);
  const tradingDayId = latest.tradingDayId;
  const ks = rows.filter((row) => row.tradingDayId === tradingDayId).map((row) => row.k);
  ks.sort((a, b) => a.time - b.time);
  const high = Math.max(...ks.map((k) => k.high));
  const low = Math.min(...ks.map((k) => k.low));
  if (!Number.isFinite(high) || !Number.isFinite(low) || high === low) return null;
  const highK = [...ks].reverse().find((k) => k.high === high);
  const lowK = [...ks].reverse().find((k) => k.low === low);
  const clock = nyClockAt(now);
  const firstClock = nyClockAt(ks[0].time);
  const lastEndClock = candleEndClock(ks.at(-1));
  const dataComplete = firstClock?.date === latest.open.date && firstClock.minute === 20 * 60
    && lastEndClock?.date === tradingDayId && lastEndClock.minute === 0
    && continuousCandles(ks);
  return {
    high,
    low,
    date: latest.open.date,
    tradingDayId,
    completed: dataComplete && !!clock && clock.date >= tradingDayId,
    dataComplete,
    bars: ks.length,
    highTime: highK?.time ?? null,
    lowTime: lowK?.time ?? null,
    activeFrom: Math.max(...ks.map((k) => k.closeTime || k.time)),
  };
}

/** 根据价位生效后的已收盘 K 标记流动性是否已消耗。 */
export function liquidityStateForLevel(level, isBuy, candles, activeFrom = level && (level.activeFrom ?? level.time)) {
  let sweptAt = null;
  let brokenAt = null;
  for (const k of candles || []) {
    if (activeFrom != null && (k.closeTime ?? k.time) <= activeFrom) continue;
    if (isBuy) {
      if (isLiquidityTakenByClose(k.close, level.price, true)) brokenAt = k.closeTime ?? k.time;
      else if (k.high > level.price && sweptAt == null) sweptAt = k.closeTime ?? k.time;
    } else {
      if (isLiquidityTakenByClose(k.close, level.price, false)) brokenAt = k.closeTime ?? k.time;
      else if (k.low < level.price && sweptAt == null) sweptAt = k.closeTime ?? k.time;
    }
  }
  if (brokenAt != null) return { state: "BROKEN", brokenAt, ...(sweptAt != null ? { sweptAt } : {}) };
  if (sweptAt != null) return { state: "SWEPT", sweptAt };
  return { state: "ACTIVE" };
}

/** 收盘恰好落在价位上也视为该 stop pool 已被拿走；与 sweep.js 共用，避免状态分裂。 */
export function isLiquidityTakenByClose(close, level, isBuy) {
  if (!Number.isFinite(Number(close)) || !Number.isFinite(Number(level))) return false;
  return isBuy ? Number(close) >= Number(level) : Number(close) <= Number(level);
}

function annotateLiquidityStates(levels, isBuy, candles) {
  for (const level of levels) Object.assign(level, liquidityStateForLevel(level, isBuy, candles));
}

function candleCloseAt(candles, index) {
  const k = index != null && candles ? candles[index] : null;
  return k ? k.closeTime ?? k.time : null;
}

/** 根据最近 4H ATR 自适应等高/等低容差，限制在 0.05%-0.30%。 */
export function resolveEqualLevelTolerance(candles, explicit = null) {
  if (Number.isFinite(Number(explicit)) && Number(explicit) > 0) return Number(explicit);
  const rows = (candles || []).slice(-15);
  if (rows.length < 2) return EQ_TOLERANCE;
  let tr = 0;
  let count = 0;
  for (let i = 1; i < rows.length; i++) {
    const k = rows[i];
    const prev = rows[i - 1];
    const value = Math.max(k.high - k.low, Math.abs(k.high - prev.close), Math.abs(k.low - prev.close));
    if (Number.isFinite(value) && value >= 0) { tr += value; count++; }
  }
  const price = Number(rows.at(-1)?.close);
  if (!count || !(price > 0)) return EQ_TOLERANCE;
  return Math.min(EQ_TOLERANCE_MAX, Math.max(EQ_TOLERANCE_MIN, (tr / count) / price * 0.1));
}

/**
 * 非传递聚类：同簇最高与最低必须直接落在容差内，防止 A≈B、B≈C 却 A 与 C
 * 已明显不等高的“链式吞并”。返回所有互不重叠的有效池，按最近形成时间排序。
 */
function clustersByPrice(items, tolerance, pick) {
  if (items.length < 2) return [];
  const sorted = [...items].sort((a, b) => a.price - b.price || a.index - b.index);
  const candidates = [];
  for (let start = 0; start < sorted.length - 1; start++) {
    for (let end = start + 1; end < sorted.length; end++) {
      const group = sorted.slice(start, end + 1);
      const min = group[0].price;
      const max = group[group.length - 1].price;
      if ((max - min) / Math.max(Math.abs(max), 1e-9) > tolerance) break;
      candidates.push(group);
    }
  }
  candidates.sort((a, b) => b.length - a.length
    || Math.max(...b.map((x) => x.index)) - Math.max(...a.map((x) => x.index)));
  const used = new Set();
  const groups = [];
  for (const group of candidates) {
    if (group.some((item) => used.has(item))) continue;
    groups.push(group);
    for (const item of group) used.add(item);
  }
  return groups.map((best) => clusterResult(best, pick))
    .sort((a, b) => b.formedIndex - a.formedIndex || b.touches - a.touches);
}

function clusterResult(best, pick) {
  const price = pick === "max" ? Math.max(...best.map((x) => x.price)) : Math.min(...best.map((x) => x.price));
  const indexes = best.map((x) => x.index).sort((a, b) => a - b);
  const ordered = [...best].sort((a, b) => a.index - b.index);
  const first = ordered[0];
  const formed = ordered[1]; // 第二个触点出现后才真正形成 EQH/EQL
  const last = best.find((x) => x.index === indexes[indexes.length - 1]);
  const result = {
    price,
    touches: best.length,
    firstIndex: indexes[0],
    lastIndex: indexes[indexes.length - 1],
  };
  // 内部用于确定流动性位的生效时刻；保持旧公共返回 schema 不变。
  Object.defineProperty(result, "formedIndex", { value: formed.index, enumerable: false });
  if (first && first.time != null) result.firstTime = first.time;
  if (formed && formed.time != null) Object.defineProperty(result, "formedTime", { value: formed.time, enumerable: false });
  if (last && last.time != null) result.lastTime = last.time;
  return result;
}

export function findEqualHighs(swings, tolerance = EQ_TOLERANCE) {
  return findEqualHighClusters(swings, tolerance)[0] || null;
}

export function findEqualLows(swings, tolerance = EQ_TOLERANCE) {
  return findEqualLowClusters(swings, tolerance)[0] || null;
}

export function findEqualHighClusters(swings, tolerance = EQ_TOLERANCE) {
  const items = (swings || []).filter((s) => s.type === "HIGH").map((s) => ({ price: s.price, index: s.index, time: s.time }));
  return clustersByPrice(items, tolerance, "max");
}

export function findEqualLowClusters(swings, tolerance = EQ_TOLERANCE) {
  const items = (swings || []).filter((s) => s.type === "LOW").map((s) => ({ price: s.price, index: s.index, time: s.time }));
  return clustersByPrice(items, tolerance, "min");
}
