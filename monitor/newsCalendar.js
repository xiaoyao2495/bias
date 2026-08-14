/**
 * newsCalendar.js — 消息面（经济日历）窗口标注
 *
 * 数据源：ForexFactory 周历 JSON（免费、无需 key，TradingView 社区指标同源）：
 *   https://nfs.faireconomy.media/ff_calendar_thisweek.json
 *   feed 挂掉/被墙 → 返回空列表，功能降级，不阻断监控。
 *
 * 范围（用户指定）：只对 股票代币 + BTCUSDT/ETHUSDT 标注消息面窗口，其他山寨币不标注。
 *   股票代币判定：Binance fapi exchangeInfo 的 underlyingType ∈ {EQUITY, KR_EQUITY}，
 *   数据驱动（不硬编码列表）；SKHYNIXUSDT/SNXXUSDT 等韩股自动覆盖。
 *   BTCUSDT / ETHUSDT 恒标注（宏观数据直接驱动 BTC/ETH 波动）。
 *
 * 缓存策略（用户指定）：每周拉一次、缓存一周。
 *   - 经济日历：data/cache/economic_calendar_thisweek.json（TTL 7 天）
 *   - exchangeInfo：data/cache/fapi_exchange_info.json（TTL 7 天 + 进程内内存缓存，
 *     常驻监控每轮不重复拉）
 *
 * 用途：在扫损 / Bias 变化消息里标注"未来 8h 有高影响数据（CPI 等）"，
 *   避免把数据发布前的扫损误读成 Judas Swing / 结构信号
 *   （ICT 2022：数据前后是机构操纵窗口，价格行为不可信）。
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProxyAgent, request } from "undici";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, "..", "data", "cache");
const CAL_FILE = join(CACHE_DIR, "economic_calendar_thisweek.json");
const EXCH_INFO_FILE = join(CACHE_DIR, "fapi_exchange_info.json");
const WEEK_MS = 7 * 24 * 3600_000;
const TIMEOUT_MS = 10_000;
const CAL_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const FAPI_BASES = ["https://fapi.binance.com", "https://fapi.binance.vision"];

// 代理同 binance.js：仅由 HTTPS_PROXY / HTTP_PROXY 显式开启；未设置则直连
const PROXY_ENV = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
const PROXY = /^https?:\/\//i.test(PROXY_ENV) ? PROXY_ENV : "";
const proxyAgent = PROXY ? new ProxyAgent(PROXY) : null;

// 恒标注消息面的主币（宏观数据直接驱动）
const ALWAYS_NEWS = new Set(["BTCUSDT", "ETHUSDT"]);
// 股票代币类型（Binance fapi underlyingType；KR_EQUITY = 韩股）
const STOCK_TYPES = new Set(["EQUITY", "KR_EQUITY"]);

// 只看美国高影响事件（FOMC / CPI / NFP / PCE / GDP 等均在此列）
const NEWS_COUNTRY = "USD";
const NEWS_IMPACT = "High";
const NEWS_HOURS = 8; // 消息面窗口：未来 8 小时
const MAX_SHOW = 3; // 消息里最多列出的事件数

// 高频事件标题 → 短名（未命中保持原样），消息更接近"未来 8h 有 CPI"
const SHORT_NAME = {
  "CPI y/y": "CPI",
  "CPI m/m": "CPI",
  "Core CPI m/m": "核心CPI",
  "Core CPI y/y": "核心CPI",
  "Non-Farm Employment Change": "非农(NFP)",
  "Unemployment Rate": "失业率",
  "FOMC Statement": "FOMC声明",
  "Fed Funds Rate": "FOMC利率决议",
  "PCE Price Index m/m": "PCE",
  "PCE Price Index y/y": "PCE",
  "Core PCE Price Index m/m": "核心PCE",
  "Core PCE Price Index y/y": "核心PCE",
  "Retail Sales m/m": "零售销售",
  "ISM Manufacturing PMI": "ISM制造业PMI",
  "Advance GDP q/q": "GDP",
  "GDP q/q": "GDP",
};

// 进程内内存缓存（常驻监控每轮调用不重复拉 exchangeInfo）
let exchInfoMemo = null; // { symbol: underlyingType }

/**
 * 拉取 JSON：代理 → 直连 兜底（与 topVolume.js 同模式，undici.request 避免 fetch+ProxyAgent bug）。
 */
async function fetchJson(url) {
  const modes = PROXY
    ? [
        { name: "proxy", opts: { dispatcher: proxyAgent } },
        { name: "direct", opts: {} },
      ]
    : [{ name: "direct", opts: {} }];
  let lastErr;
  for (const mode of modes) {
    try {
      const { statusCode, body } = await request(url, {
        ...mode.opts,
        headersTimeout: TIMEOUT_MS,
        bodyTimeout: TIMEOUT_MS,
      });
      if (statusCode !== 200) throw new Error(`HTTP ${statusCode}`);
      return JSON.parse(await body.text());
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`请求失败: ${lastErr && lastErr.message}`);
}

/**
 * 加载本周经济日历（缓存一周）。feed 失败 → 回退旧缓存；无缓存 → 返回 []（降级）。
 * @returns {Promise<Array<{title,country,date,impact,forecast,previous}>>}
 */
export async function loadCalendarEvents({ force = false } = {}) {
  if (!force && existsSync(CAL_FILE) && Date.now() - statSync(CAL_FILE).mtimeMs < WEEK_MS) {
    try {
      return JSON.parse(readFileSync(CAL_FILE, "utf8"));
    } catch {}
  }
  try {
    const data = await fetchJson(CAL_URL);
    const list = Array.isArray(data) ? data : data && Array.isArray(data.thisWeek) ? data.thisWeek : [];
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CAL_FILE, JSON.stringify(list));
    return list;
  } catch (e) {
    try {
      return JSON.parse(readFileSync(CAL_FILE, "utf8"));
    } catch {
      return [];
    }
  }
}

/**
 * 加载 Binance fapi exchangeInfo 的 underlyingType 映射（缓存一周 + 进程内内存缓存）。
 * 失败 → 回退旧缓存；无缓存 → 返回 {}（此时只有 BTCUSDT/ETHUSDT 恒标注）。
 * @returns {Promise<Object<string,string>>} { symbol: underlyingType }
 */
export async function loadExchangeInfo({ force = false } = {}) {
  if (exchInfoMemo && !force) return exchInfoMemo;
  if (!force && existsSync(EXCH_INFO_FILE) && Date.now() - statSync(EXCH_INFO_FILE).mtimeMs < WEEK_MS) {
    try {
      const m = JSON.parse(readFileSync(EXCH_INFO_FILE, "utf8"));
      if (m && typeof m === "object") {
        exchInfoMemo = m;
        return m;
      }
    } catch {}
  }
  let data = null;
  for (const base of FAPI_BASES) {
    try {
      data = await fetchJson(`${base}/fapi/v1/exchangeInfo`);
      break;
    } catch {}
  }
  if (data && Array.isArray(data.symbols)) {
    const map = {};
    for (const s of data.symbols) map[s.symbol] = s.underlyingType || "";
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(EXCH_INFO_FILE, JSON.stringify(map));
    exchInfoMemo = map;
    return map;
  }
  try {
    const m = JSON.parse(readFileSync(EXCH_INFO_FILE, "utf8"));
    exchInfoMemo = m;
    return m;
  } catch {
    exchInfoMemo = {};
    return {};
  }
}

/**
 * 过滤未来窗口内的美国高影响事件（纯函数，可测）。
 * @param {Array} events 原始日历（{title,country,date,impact}）
 * @param {number} now 当前时间戳（ms）
 * @param {number} hours 消息面窗口小时数
 * @returns {Array<{title,country,impact,ts,raw}>} 按时间升序
 */
export function filterUpcomingEvents(events, now = Date.now(), hours = NEWS_HOURS) {
  const end = now + hours * 3600_000;
  return (events || [])
    .map((e) => ({ ...e, ts: new Date(e.date).getTime() }))
    .filter((e) => Number.isFinite(e.ts) && e.ts >= now && e.ts <= end)
    .filter((e) => e.country === NEWS_COUNTRY && e.impact === NEWS_IMPACT)
    .sort((a, b) => a.ts - b.ts);
}

/** 该合约是否标注消息面窗口（纯函数）：BTCUSDT/ETHUSDT 恒是；其余看 exchangeInfo 类型 */
export function isNewsRelevantSymbol(symbol, exchInfo = {}) {
  if (ALWAYS_NEWS.has(symbol)) return true;
  return STOCK_TYPES.has(exchInfo[symbol]);
}

/**
 * 生成消息面标注行（纯函数，可测）；不相关合约 / 窗口内无高影响数据 → null。
 * @param {string} symbol
 * @param {Array} events 原始日历
 * @param {Object} exchInfo { symbol: underlyingType }
 * @param {number} [opts.now] 当前时间戳（测试注入）
 * @param {number} [opts.hours] 消息面窗口小时数
 * @returns {string|null} 例："未来 8h 有 CPI（20:30）—— 数据前波动多为操纵，勿当方向信号"
 */
export function newsLineFor(symbol, events, exchInfo = {}, { now = Date.now(), hours = NEWS_HOURS } = {}) {
  if (!isNewsRelevantSymbol(symbol, exchInfo)) return null;
  const upcoming = filterUpcomingEvents(events, now, hours);
  if (!upcoming.length) return null;
  const shown = upcoming.slice(0, MAX_SHOW).map((e) => `${shortName(e.title)}（${bjLabel(e.ts, now)}）`);
  const more = upcoming.length > MAX_SHOW ? ` 等 ${upcoming.length} 项` : "";
  return `未来 ${hours}h 有高影响数据 ${shown.join("、")}${more} —— 数据前波动多为操纵，勿当方向信号`;
}

/** 事件标题 → 短名 */
function shortName(title) {
  return SHORT_NAME[title] || title || "数据";
}

/** 北京时间标签：当天只显 HH:mm，跨天补 MM-DD */
function bjLabel(ts, now) {
  const opts = { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false };
  const sameDay =
    new Date(ts).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" }) ===
    new Date(now).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" });
  if (sameDay) return new Date(ts).toLocaleString("zh-CN", opts);
  return new Date(ts).toLocaleString("zh-CN", { ...opts, month: "2-digit", day: "2-digit" });
}
