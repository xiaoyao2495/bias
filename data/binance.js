/**
 * binance.js — 数据层：获取 K 线（本地缓存优先 + 本地代理拉取）
 *
 * 策略：
 *   1. 本地缓存存在且未过期 → 直接读本地文件，不发网络请求
 *   2. 否则请求 Binance（直连，或设置 HTTPS_PROXY/HTTP_PROXY 时走代理）→ 写入本地缓存
 *   3. 网络失败但有旧缓存 → 回退旧缓存并告警（离线也能跑）
 *
 * 缓存目录：data/cache/{SYMBOL}_{INTERVAL}_{LIMIT}_perp.json
 *   长历史（getHistory）：data/cache/{SYMBOL}_{INTERVAL}_h{COUNT}_perp.json
 * 缓存过期：默认 4 小时（可用环境变量 BIAS_CACHE_TTL_HOURS 覆盖），
 *           且不超过对应 K 线周期（日=24h，周=7d）。
 * 代理：默认直连；仅当设置 HTTPS_PROXY / HTTP_PROXY（http 代理）时才走代理。
 *       （服务器无需代理直接可用；本地需代理时 export HTTPS_PROXY=http://127.0.0.1:7890）
 * 数据源：统一使用 Binance 永续合约（fapi）K 线 —— 监控对象是 USDT 永续，
 *       BTC/ETH 等传统合约永续与现货结构几乎一致，杠杆代币/商品永续只在 fapi 存在。
 *
 * K 线格式（统一）：
 *   { time, open, high, low, close, closeTime, quoteVol }
 *   time      — 开盘时间 (ms)
 *   closeTime — 收盘时间 (ms)，用于判断该 K 线是否已收盘
 *   quoteVol  — 成交量（USDT 成交额），数据驱动 Killzone（活跃时段）用
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProxyAgent, request } from "undici";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, "cache");

const PERP_BASES = ["https://fapi.binance.com", "https://fapi.binance.vision"]; // 公开永续合约行情端点
const TIMEOUT_MS = 10_000;

// 代理仅由环境变量显式开启（只认 http/https 代理，避免 socks 冲突）；未设置则直连
const PROXY_ENV = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
const PROXY = /^https?:\/\//i.test(PROXY_ENV) ? PROXY_ENV : "";
const proxyAgent = PROXY ? new ProxyAgent(PROXY) : null;

const DEFAULT_TTL_MS = (Number(process.env.BIAS_CACHE_TTL_HOURS) || 4) * 3600_000;
const INTERVAL_MS = { "5m": 5 * 60_000, "4h": 4 * 3600_000, "1d": 24 * 3600_000, "1w": 7 * 24 * 3600_000 };

/** 各周期缓存 TTL 覆盖（分钟）：
 *  4H 是监控主周期，TTL 必须小于周期本身——否则 4H 收盘后缓存仍未过期，
 *  收盘报告滞后一根、结构/MSS 检测最长滞后 4h（M1 修复，见审计）。
 *  30min 折中（监控 10 分钟一轮 × 3），既及时看到新收盘 K，又避免每轮拉取。
 *  1h 供数据驱动 Killzone（活跃窗口）：每周一刷新一次（拉上周交易周数据），TTL 一周。 */
const TTL_OVERRIDE_MIN = { "4h": 30, "1h": 7 * 24 * 60 };

function mapKline(k) {
  return {
    time: k[0], // openTime
    open: +k[1],
    high: +k[2],
    low: +k[3],
    close: +k[4],
    quoteVol: +k[7] || 0, // 成交量（USDT 成交额），数据驱动 Killzone 用；旧缓存缺字段时为 0
    closeTime: k[6],
  };
}

function cacheFile(symbol, interval, limit) {
  return join(CACHE_DIR, `${symbol}_${interval}_${limit}_perp.json`);
}

function readCache(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeCache(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data));
}

function ttlMs(interval) {
  const base = TTL_OVERRIDE_MIN[interval] != null ? TTL_OVERRIDE_MIN[interval] * 60_000 : (INTERVAL_MS[interval] || DEFAULT_TTL_MS);
  // 1h（数据驱动 Killzone）按周刷新，不受 4h 全局上限约束；其余周期仍受 DEFAULT 上限
  const cap = interval === "1h" ? 7 * 24 * 3600_000 : DEFAULT_TTL_MS;
  return Math.min(cap, base);
}

/** 获取 K 线：优先读本地缓存，未命中则经代理拉取并落盘。
 *  @param {Object} [opts.force] 跳过缓存强制拉取（4H 收盘报告用：边界轮必须拿到最新已收盘 K，见 M1） */
export async function getKlines(symbol, interval, limit = 500, { force = false } = {}) {
  const file = cacheFile(symbol, interval, limit);

  if (!force && existsSync(file) && Date.now() - statSync(file).mtimeMs < ttlMs(interval)) {
    const cached = readCache(file);
    if (cached) {
      console.error(`[binance] 命中本地缓存: ${file}`);
      return cached;
    }
  }

  try {
    const data = await fetchFromBinance(symbol, interval, limit);
    writeCache(file, data);
    console.error(`[binance] 已拉取并写入缓存: ${file}`);
    return data;
  } catch (e) {
    const cached = readCache(file);
    if (cached) {
      console.error(`[binance] 网络请求失败(${e.message})，回退本地缓存: ${file}`);
      return cached;
    }
    throw e;
  }
}

/**
 * 分批拉取最近 count 根 K 线（单次上限 1000，自动分页），时间升序。
 * 用于回放（Case Replay）等需要长历史数据的场景。
 * 缓存文件：{SYMBOL}_{INTERVAL}_h{count}.json
 */
export async function getHistory(symbol, interval, count, { force = false } = {}) {
  const file = cacheFile(symbol, interval, `h${count}`);

  if (!force && existsSync(file) && Date.now() - statSync(file).mtimeMs < ttlMs(interval)) {
    const cached = readCache(file);
    if (cached) {
      console.error(`[binance] 命中本地缓存: ${file}`);
      return cached;
    }
  }

  try {
    const page = 1000;
    const all = [];
    let endTime = null;
    while (all.length < count) {
      const data = await fetchFromBinance(symbol, interval, page, null, endTime);
      if (!data.length) break;
      all.push(...data);
      if (data.length < page) break; // 已到可获取的最早历史
      endTime = data[0].time - 1; // 向前翻页：下一页在最早一根 K 之前
    }
    const result = all.sort((a, b) => a.time - b.time).slice(-count);
    writeCache(file, result);
    console.error(`[binance] 已拉取并写入缓存: ${file} (${result.length} 根)`);
    return result;
  } catch (e) {
    const cached = readCache(file);
    if (cached) {
      console.error(`[binance] 网络请求失败(${e.message})，回退本地缓存: ${file}`);
      return cached;
    }
    throw e;
  }
}

/**
 * 从 Binance 永续合约（fapi）拉取 K 线：代理 → 直连（无代理直接直连）、多端点轮询。
 * 统一使用永续数据：监控对象是 USDT 永续，杠杆代币/商品永续只在 fapi 存在；
 * BTC/ETH 等传统合约永续与现货结构几乎一致，直接用永续保证数据源一致。
 * 注意：必须用 undici.request 而非 fetch —— undici 8.10 的 fetch + ProxyAgent 存在
 * UND_ERR_INVALID_ARG 兼容 bug，request API 正常。
 */
async function fetchFromBinance(symbol, interval, limit, startTime = null, endTime = null) {
  const modes = PROXY
    ? [
        { name: "proxy", opts: { dispatcher: proxyAgent } },
        { name: "direct", opts: {} },
      ]
    : [{ name: "direct", opts: {} }];
  let lastErr;
  for (const base of PERP_BASES) {
    for (const mode of modes) {
      try {
        const st = startTime == null ? "" : `&startTime=${startTime}`;
        const et = endTime == null ? "" : `&endTime=${endTime}`;
        const url = `${base}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}${st}${et}`;
        const { statusCode, body } = await request(url, {
          ...mode.opts,
          headersTimeout: TIMEOUT_MS,
          bodyTimeout: TIMEOUT_MS,
        });
        if (statusCode !== 200) throw new Error(`HTTP ${statusCode}`);
        const data = JSON.parse(await body.text());
        if (!Array.isArray(data)) throw new Error("响应格式异常");
        return data.map(mapKline);
      } catch (e) {
        lastErr = e;
      }
    }
  }
  throw new Error(`获取 ${symbol} ${interval} K线失败: ${lastErr && lastErr.message}`);
}

/** 4H K 线（主输入） */
export function get4hKlines(symbol, limit = 500) {
  return getKlines(symbol, "4h", limit);
}

/** 日 K 线（用于 PDH / PDL） */
export function getDailyKlines(symbol, limit = 30) {
  return getKlines(symbol, "1d", limit);
}

/** 周 K 线（用于 PWH / PWL） */
export function getWeeklyKlines(symbol, limit = 10) {
  return getKlines(symbol, "1w", limit);
}
