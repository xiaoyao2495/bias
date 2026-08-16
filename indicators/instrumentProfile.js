/**
 * instrumentProfile.js — 合约市场制度的唯一事实来源。
 *
 * ICT 的 Swing / MSS / FVG / OB / Premium-Discount 定义不因品种改变；需要按品种
 * 分开的只是交易日、形成流动性的 Session 与允许执行的 Killzone。
 */

export const INSTRUMENT_KIND = Object.freeze({
  EQUITY_LINKED: "EQUITY_LINKED",
  COMMODITY_LINKED: "COMMODITY_LINKED",
  CRYPTO_24X7: "CRYPTO_24X7",
});

export const SESSION_MODEL = Object.freeze({
  US_EQUITY: "US_EQUITY",
  KR_EQUITY: "KR_EQUITY",
  HK_EQUITY: "HK_EQUITY",
  COMMODITY_24X5: "COMMODITY_24X5",
  CRYPTO_24X7: "CRYPTO_24X7",
});

export const HTF_LIQUIDITY_SOURCE = Object.freeze({
  EXCHANGE_UTC: "EXCHANGE_UTC",
  REGULAR_SESSION: "REGULAR_SESSION",
});

const REGULAR_SESSIONS = Object.freeze({
  [SESSION_MODEL.US_EQUITY]: Object.freeze({
    timeZone: "America/New_York",
    startMinute: 9 * 60 + 30,
    endMinute: 16 * 60,
    weekdays: Object.freeze(["Mon", "Tue", "Wed", "Thu", "Fri"]),
  }),
  [SESSION_MODEL.KR_EQUITY]: Object.freeze({
    timeZone: "Asia/Seoul",
    startMinute: 9 * 60,
    endMinute: 15 * 60 + 30,
    weekdays: Object.freeze(["Mon", "Tue", "Wed", "Thu", "Fri"]),
  }),
  [SESSION_MODEL.HK_EQUITY]: Object.freeze({
    timeZone: "Asia/Hong_Kong",
    startMinute: 9 * 60 + 30,
    endMinute: 16 * 60,
    // 港股现金市场有午休；分段校验避免把 12:00-13:00 永续价格混入标的 RTH。
    segments: Object.freeze([
      Object.freeze({ startMinute: 9 * 60 + 30, endMinute: 12 * 60 }),
      Object.freeze({ startMinute: 13 * 60, endMinute: 16 * 60 }),
    ]),
    weekdays: Object.freeze(["Mon", "Tue", "Wed", "Thu", "Fri"]),
  }),
});

const EQUITY_TYPES = new Set(["EQUITY", "KR_EQUITY", "HK_EQUITY"]);
// exchangeInfo 暂不可用时的保守兜底。仅显式列出的商品/贵金属采用商品时钟，
// 其余未知 USDT 永续仍按 Crypto 处理，避免用名称猜测市场制度。
const UNDERLYING_FALLBACK = new Map([
  ["MU", "EQUITY"],
  ["SNDK", "EQUITY"],
  ["SOXL", "EQUITY"],
  ["SPCX", "EQUITY"],
  ["KORU", "KR_EQUITY"],
  ["SKHYNIX", "KR_EQUITY"],
  ["SNXX", "KR_EQUITY"],
  ["XAU", "COMMODITY"],
  ["XAG", "COMMODITY"],
  ["XPT", "COMMODITY"],
  ["XPD", "COMMODITY"],
  ["COPPER", "COMMODITY"],
  ["CL", "COMMODITY"],
  ["BZ", "COMMODITY"],
  ["NATGAS", "COMMODITY"],
]);
// 交易所偶尔把地区股票统一报为 EQUITY；这些已知标的必须服从本地交易时钟。
const SESSION_TYPE_OVERRIDE = new Map([
  ["KORU", "KR_EQUITY"],
  ["SKHYNIX", "KR_EQUITY"],
  ["SNXX", "KR_EQUITY"],
]);

/** 统一 symbol，当前项目只处理 USDT 永续。 */
export function normalizeSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

function underlyingTypeOf(symbol, exchangeInfo) {
  const raw = exchangeInfo?.[symbol];
  if (typeof raw === "string") return raw.toUpperCase();
  if (raw && typeof raw === "object") return String(raw.underlyingType || "").toUpperCase();
  return "";
}

/**
 * @param {string} symbol
 * @param {Object<string,string|Object>} exchangeInfo Binance symbol → underlyingType 映射
 */
export function resolveInstrumentProfile(symbol, exchangeInfo = {}) {
  const normalized = normalizeSymbol(symbol);
  const base = normalized.replace(/USDT$/, "");
  const exchangeType = underlyingTypeOf(normalized, exchangeInfo);
  const fallbackType = UNDERLYING_FALLBACK.get(base) || "";
  const underlyingType = SESSION_TYPE_OVERRIDE.get(base) || exchangeType || fallbackType || "COIN";
  const equityLinked = EQUITY_TYPES.has(underlyingType);
  const commodityLinked = underlyingType === "COMMODITY";
  const sessionModel = underlyingType === "KR_EQUITY"
    ? SESSION_MODEL.KR_EQUITY
    : underlyingType === "HK_EQUITY"
      ? SESSION_MODEL.HK_EQUITY
    : commodityLinked
      ? SESSION_MODEL.COMMODITY_24X5
    : equityLinked
      ? SESSION_MODEL.US_EQUITY
      : SESSION_MODEL.CRYPTO_24X7;

  if (equityLinked) {
    return Object.freeze({
      symbol: normalized,
      kind: INSTRUMENT_KIND.EQUITY_LINKED,
      sessionModel,
      underlyingType,
      continuous: false,
      // 市场日界线与 ICT 钟表必须分开。股票流动性服从标的现金市场；
      // ICT Session 仍按课程使用纽约当地时间。
      marketTimeZone: sessionModel === SESSION_MODEL.KR_EQUITY
        ? "Asia/Seoul"
        : sessionModel === SESSION_MODEL.HK_EQUITY
          ? "Asia/Hong_Kong"
          : "America/New_York",
      ictTimeZone: "America/New_York",
      tradingTimeZone: sessionModel === SESSION_MODEL.KR_EQUITY
        ? "Asia/Seoul"
        : sessionModel === SESSION_MODEL.HK_EQUITY
          ? "Asia/Hong_Kong"
          : "America/New_York", // 兼容旧调用
      htfLiquiditySource: HTF_LIQUIDITY_SOURCE.REGULAR_SESSION,
      regularSession: REGULAR_SESSIONS[sessionModel],
      accumulationSession: sessionModel === SESSION_MODEL.US_EQUITY ? "PRE_MARKET" : null,
      executionSessions: sessionModel === SESSION_MODEL.US_EQUITY ? Object.freeze(["NEW_YORK"]) : Object.freeze([]),
    });
  }

  if (commodityLinked) {
    return Object.freeze({
      symbol: normalized,
      kind: INSTRUMENT_KIND.COMMODITY_LINKED,
      sessionModel: SESSION_MODEL.COMMODITY_24X5,
      underlyingType,
      continuous: false,
      // 贵金属/能源合约按纽约商品期货交易周建模。HTF K 仍使用交易所原生 UTC，
      // 但交易日身份和流动性事件门禁不再冒充 Crypto 24×7。
      marketTimeZone: "America/New_York",
      ictTimeZone: "America/New_York",
      tradingTimeZone: "America/New_York",
      htfLiquiditySource: HTF_LIQUIDITY_SOURCE.EXCHANGE_UTC,
      regularSession: null,
      accumulationSession: "ASIA",
      executionSessions: Object.freeze(["LONDON", "NEW_YORK"]),
    });
  }

  return Object.freeze({
    symbol: normalized,
    kind: INSTRUMENT_KIND.CRYPTO_24X7,
    sessionModel: SESSION_MODEL.CRYPTO_24X7,
    underlyingType,
    continuous: true,
    // Binance 1D/1W（UTC）定义 PDH/PDL/PWH/PWL；纽约时间只定义 ICT Session。
    marketTimeZone: "UTC",
    ictTimeZone: "America/New_York",
    tradingTimeZone: "UTC", // 兼容旧调用；不再把 Crypto 市场日误标为纽约日
    htfLiquiditySource: HTF_LIQUIDITY_SOURCE.EXCHANGE_UTC,
    regularSession: null,
    accumulationSession: "ASIA",
    executionSessions: Object.freeze(["LONDON", "NEW_YORK"]),
  });
}

export function isEquityLinkedProfile(profile) {
  return profile?.kind === INSTRUMENT_KIND.EQUITY_LINKED;
}

export function isExternalMarketProfile(profile) {
  return profile?.kind === INSTRUMENT_KIND.EQUITY_LINKED
    || profile?.kind === INSTRUMENT_KIND.COMMODITY_LINKED;
}

function minuteInsideSession(clock, session) {
  if (!clock || !session || !session.weekdays.includes(clock.weekday)) return false;
  const segments = session.segments?.length ? session.segments : [session];
  return segments.some((segment) => clock.minute >= segment.startMinute && clock.minute < segment.endMinute);
}

/**
 * 流动性事件可用时段。外部资产关联合约在标的休市时的永续波动不升级为 ICT Sweep。
 * Commodity 使用常见 CME 电子盘：周日 18:00 ET 开、周五 17:00 ET 收，工作日
 * 17:00-18:00 ET 维护休市。该门禁是保守工程模型，不伪装成逐品种交易所日历。
 */
export function isLiquidityEventTimeForProfile(profile, time) {
  if (!Number.isFinite(Number(time))) return false;
  if (!profile || profile.sessionModel === SESSION_MODEL.CRYPTO_24X7) return true;
  if (profile.sessionModel === SESSION_MODEL.COMMODITY_24X5) {
    const clock = nyClockAt(time);
    if (!clock || clock.weekday === "Sat") return false;
    if (clock.weekday === "Sun") return clock.minute >= 18 * 60;
    if (clock.weekday === "Fri") return clock.minute < 17 * 60;
    return clock.minute < 17 * 60 || clock.minute >= 18 * 60;
  }
  const session = profile.regularSession;
  return minuteInsideSession(zonedClockAt(time, session?.timeZone), session);
}

export function isExecutionSessionForProfile(profile, ictSession, time = null) {
  const name = typeof ictSession === "string" ? ictSession : ictSession?.name;
  if (!name || !Array.isArray(profile?.executionSessions) || !profile.executionSessions.includes(name)) return false;
  if (profile?.sessionModel === SESSION_MODEL.COMMODITY_24X5 && Number.isFinite(Number(time))) {
    return isLiquidityEventTimeForProfile(profile, time);
  }
  if (profile?.sessionModel === SESSION_MODEL.US_EQUITY && Number.isFinite(Number(time))) {
    const clock = nyClockAt(time);
    return !!clock && !["Sat", "Sun"].includes(clock.weekday)
      && clock.minute >= 9 * 60 + 30 && clock.minute < 10 * 60;
  }
  return true;
}

/** America/New_York 本地钟表字段；DST 交给 IANA 时区。 */
export function nyClockAt(time) {
  if (!Number.isFinite(Number(time))) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
    hourCycle: "h23", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(Number(time)));
  const p = Object.fromEntries(parts.map((item) => [item.type, item.value]));
  const hour = Number(p.hour) % 24;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    weekday: p.weekday,
    hour,
    minute: hour * 60 + Number(p.minute),
  };
}

/** 任意 IANA 时区的本地钟表字段；用于标的现金市场日线聚合。 */
export function zonedClockAt(time, timeZone = "UTC") {
  if (!Number.isFinite(Number(time))) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
    hourCycle: "h23", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(Number(time)));
  const p = Object.fromEntries(parts.map((item) => [item.type, item.value]));
  const hour = Number(p.hour) % 24;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    weekday: p.weekday,
    hour,
    minute: hour * 60 + Number(p.minute),
  };
}

export function addIsoDays(date, days) {
  const [year, month, day] = String(date).split("-").map(Number);
  if (![year, month, day].every(Number.isFinite)) return null;
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return d.toISOString().slice(0, 10);
}

/**
 * 同一日内模型的证据键。
 * Crypto 的 Asia 20:00-00:00 ET 归入次日；美股盘前归入当日现金交易日。
 */
export function tradingDayIdAt(time, profile) {
  const clock = nyClockAt(time);
  if (!clock) return null;
  if (profile?.sessionModel === SESSION_MODEL.CRYPTO_24X7 && clock.minute >= 20 * 60) {
    return addIsoDays(clock.date, 1);
  }
  if (profile?.sessionModel === SESSION_MODEL.CRYPTO_24X7) return clock.date;
  if (profile?.sessionModel === SESSION_MODEL.COMMODITY_24X5) {
    return clock.minute >= 18 * 60 ? addIsoDays(clock.date, 1) : clock.date;
  }
  return marketDayIdAt(time, profile);
}

/**
 * 市场原生日 ID。注意：它不同于上面的 ICT 日内模型证据键。
 * Crypto 使用交易所 UTC 日；股票关联使用标的市场当地日期。
 */
export function marketDayIdAt(time, profile) {
  const zone = profile?.marketTimeZone || (profile?.sessionModel === SESSION_MODEL.CRYPTO_24X7 ? "UTC" : profile?.tradingTimeZone) || "UTC";
  return zonedClockAt(time, zone)?.date || null;
}

export function profileLabel(profile) {
  if (profile?.sessionModel === SESSION_MODEL.US_EQUITY) return "美股关联";
  if (profile?.sessionModel === SESSION_MODEL.KR_EQUITY) return "韩股关联";
  if (profile?.sessionModel === SESSION_MODEL.HK_EQUITY) return "港股关联";
  if (profile?.sessionModel === SESSION_MODEL.COMMODITY_24X5) return "商品关联";
  return "24×7加密";
}
