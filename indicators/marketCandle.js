/**
 * marketCandle.js — 把“市场日”与“ICT 纽约钟表”解耦。
 *
 * - 24×7 Crypto：PDH/PDL/PWH/PWL 沿用交易所原生 UTC 1D/1W。
 * - 股票关联永续：不能把永续的盘前/盘后高低冒充标的现金时段高低，改由日内 K
 *   聚合标的 Regular Trading Hours；不完整 Session 不产生 HTF 流动性。
 *
 * 该模块只决定 HTF 流动性 K 的来源，不改动用于趋势叙事的交易所日/周历史。
 */

import {
  HTF_LIQUIDITY_SOURCE,
  zonedClockAt,
} from "./instrumentProfile.js";

function isoWeekMonday(date) {
  const [year, month, day] = String(date).split("-").map(Number);
  if (![year, month, day].every(Number.isFinite)) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  const weekday = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - weekday + 1);
  return d.toISOString().slice(0, 10);
}

function candleDurationMinutes(k) {
  const duration = Number(k?.closeTime) - Number(k?.time);
  return Number.isFinite(duration) && duration > 0 ? Math.max(1, Math.round(duration / 60_000)) : null;
}

function rowsAreContinuous(rows) {
  const sorted = [...rows].sort((a, b) => a.time - b.time);
  return sorted.every((k, index) => {
    if (index === 0) return true;
    const gap = Number(k.time) - Number(sorted[index - 1].closeTime);
    return Number.isFinite(gap) && gap >= 0 && gap <= 1;
  });
}

function addIsoDays(date, days) {
  const [year, month, day] = String(date).split("-").map(Number);
  if (![year, month, day].every(Number.isFinite)) return null;
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function sessionSegments(session) {
  return session?.segments?.length ? session.segments : [session];
}

function rowInsideSegment(open, close, segment) {
  return open.minute >= segment.startMinute && open.minute < segment.endMinute
    && close.minute <= segment.endMinute;
}

function segmentIsComplete(rows, session, segment) {
  const inside = rows.filter((k) => {
    const open = zonedClockAt(k.time, session.timeZone);
    const close = zonedClockAt(k.closeTime, session.timeZone);
    return open && close && rowInsideSegment(open, close, segment);
  }).sort((a, b) => a.time - b.time);
  if (!inside.length || !rowsAreContinuous(inside)) return false;
  const firstClock = zonedClockAt(inside[0].time, session.timeZone);
  const lastClock = zonedClockAt(inside.at(-1).closeTime, session.timeZone);
  const duration = candleDurationMinutes(inside[0]) || 5;
  return firstClock?.minute <= segment.startMinute
    && lastClock?.minute >= segment.endMinute - Math.max(0, duration - 1);
}

function aggregateRows(rows, metadata) {
  const sorted = [...rows].sort((a, b) => a.time - b.time);
  const first = sorted[0];
  const last = sorted.at(-1);
  const high = Math.max(...sorted.map((k) => Number(k.high)));
  const low = Math.min(...sorted.map((k) => Number(k.low)));
  const highK = [...sorted].reverse().find((k) => Number(k.high) === high);
  const lowK = [...sorted].reverse().find((k) => Number(k.low) === low);
  const sum = (field) => sorted.reduce((total, k) => total + (Number(k[field]) || 0), 0);
  return {
    time: first.time,
    closeTime: last.closeTime,
    open: first.open,
    high,
    low,
    close: last.close,
    volume: sum("volume"),
    quoteVol: sum("quoteVol"),
    highTime: highK?.time ?? null,
    lowTime: lowK?.time ?? null,
    bars: sorted.length,
    ...metadata,
  };
}

/**
 * 从日内 K 聚合已经完整结束的标的现金时段日/周 K。
 * 只接受首尾都覆盖开收盘边界的数据；宁可缺失，也不使用盘前/盘后或部分时段伪造 PDH。
 */
export function aggregateRegularSessionCandles(intraday, profile, now) {
  const session = profile?.regularSession;
  if (!session || !Array.isArray(intraday) || !intraday.length || !Number.isFinite(Number(now))) {
    return { daily: [], weekly: [], source: HTF_LIQUIDITY_SOURCE.REGULAR_SESSION, complete: false };
  }

  const nowClock = zonedClockAt(now, session.timeZone);
  if (!nowClock) return { daily: [], weekly: [], source: HTF_LIQUIDITY_SOURCE.REGULAR_SESSION, complete: false };

  const groups = new Map();
  for (const k of intraday) {
    if (k?.time == null || k?.closeTime == null || k.closeTime > now) continue;
    const open = zonedClockAt(k.time, session.timeZone);
    const close = zonedClockAt(k.closeTime, session.timeZone);
    if (!open || !close || open.date !== close.date || !session.weekdays.includes(open.weekday)) continue;
    if (!sessionSegments(session).some((segment) => rowInsideSegment(open, close, segment))) continue;
    const rows = groups.get(open.date) || [];
    rows.push(k);
    groups.set(open.date, rows);
  }

  const daily = [];
  for (const [date, rows] of groups) {
    const sorted = [...rows].sort((a, b) => a.time - b.time);
    const sessionEnded = date < nowClock.date || (date === nowClock.date && nowClock.minute >= session.endMinute);
    const completeSegments = sessionSegments(session).every((segment) => segmentIsComplete(sorted, session, segment));
    if (!sessionEnded || !completeSegments) continue;
    daily.push(aggregateRows(sorted, {
      tradingDayId: date,
      periodId: date,
      source: HTF_LIQUIDITY_SOURCE.REGULAR_SESSION,
      sessionModel: profile.sessionModel,
      timeZone: session.timeZone,
    }));
  }
  daily.sort((a, b) => a.time - b.time);

  const weekGroups = new Map();
  for (const candle of daily) {
    const weekId = isoWeekMonday(candle.tradingDayId);
    if (!weekId) continue;
    const rows = weekGroups.get(weekId) || [];
    rows.push(candle);
    weekGroups.set(weekId, rows);
  }
  const currentWeekId = isoWeekMonday(nowClock.date);
  const weekdayNumber = new Date(`${nowClock.date}T00:00:00Z`).getUTCDay() || 7;
  const weekly = [];
  for (const [weekId, rows] of weekGroups) {
    const weekEnded = weekId < currentWeekId
      || (weekId === currentWeekId && (weekdayNumber > 5 || (weekdayNumber === 5 && nowClock.minute >= session.endMinute)));
    // 没有交易所节假日日历时采取保守策略：只有周一至周五五个完整现金时段都存在，
    // 才能把该周升级为 PWH/PWL。宁可在节假日周暂缺周流动性，也不拿半周极值冒充完整周。
    const dates = new Set(rows.map((row) => row.tradingDayId));
    const completeTradingWeek = session.weekdays.every((_, offset) => dates.has(addIsoDays(weekId, offset)));
    if (!weekEnded || !completeTradingWeek) continue;
    weekly.push(aggregateRows(rows, {
      tradingWeekId: weekId,
      periodId: weekId,
      source: HTF_LIQUIDITY_SOURCE.REGULAR_SESSION,
      sessionModel: profile.sessionModel,
      timeZone: session.timeZone,
    }));
  }
  weekly.sort((a, b) => a.time - b.time);
  return { daily, weekly, source: HTF_LIQUIDITY_SOURCE.REGULAR_SESSION, complete: daily.length > 0 };
}

/** 为 computeLiquidity 选择 PD/PW 的 K 线来源。 */
export function selectHtfLiquidityCandles({ daily = [], weekly = [], intraday = [], profile, now }) {
  if (profile?.htfLiquiditySource !== HTF_LIQUIDITY_SOURCE.REGULAR_SESSION) {
    return {
      daily,
      weekly,
      source: HTF_LIQUIDITY_SOURCE.EXCHANGE_UTC,
      complete: true,
    };
  }
  return aggregateRegularSessionCandles(intraday, profile, now);
}

/** 交易所原生 UTC 日 ID，供 Crypto HTF 流动性元数据使用。 */
export function exchangeUtcDayId(candle) {
  return zonedClockAt(candle?.time, "UTC")?.date || null;
}

/**
 * ICT 2022 New York Midnight Open：独立参考价，不是 PDH/PDL，也不改变 Crypto UTC 日线。
 * 仅接受恰好从纽约 00:00 开始且在 now 前已经收盘的 K，避免用近似价冒充午夜开盘。
 */
export function findNewYorkMidnightOpen(intraday, now) {
  if (!Array.isArray(intraday) || !intraday.length || !Number.isFinite(Number(now))) return null;
  for (let i = intraday.length - 1; i >= 0; i--) {
    const k = intraday[i];
    if (k?.time == null || k?.closeTime == null || k.closeTime > now) continue;
    const clock = zonedClockAt(k.time, "America/New_York");
    if (!clock || clock.minute !== 0) continue;
    return {
      type: "NEW_YORK_MIDNIGHT_OPEN",
      price: k.open,
      time: k.time,
      activeFrom: k.time,
      tradingDayId: clock.date,
      timeZone: "America/New_York",
      liquidity: false,
      source: "ICT_REFERENCE_PRICE",
    };
  }
  return null;
}

export function regularSessionSupported(profile) {
  return !!profile?.regularSession;
}
