/**
 * topVolume.js — Monitor Step 1：Binance USDT 永续 24h 成交额 Top N
 *
 * 数据源：Binance Futures 公开行情（fapi）。
 * 一次拉取全部 24h ticker（/fapi/v1/ticker/24hr），
 * 过滤 USDT 永续（symbol 以 USDT 结尾），
 * 按 24h 成交额（quoteVolume，单位 USDT）降序取 Top N。
 * 支持 exclude 排除名单（如不想监控的币种）：先排序再剔除，被排除者在 N 内由后续补位。
 * 不做额外过滤：含杠杆代币（如 SNDK/SOXL/KORU）按成交量参与排序（用户指定）。
 *
 * 网络策略：默认直连；仅当设置了 HTTPS_PROXY / HTTP_PROXY（http 代理）时才走代理。
 * 服务器（国外）无需代理直接可用；本地需代理时 export HTTPS_PROXY=http://127.0.0.1:7890。
 * 不落缓存：ticker 全量一次请求，监控每小时一次，无需缓存。
 *
 * 用法：
 *   node monitor/topVolume.js            # 输出 Top 10（含成交额）
 *   node monitor/topVolume.js 20         # 输出 Top 20
 */
import { ProxyAgent, request } from "undici";
import { pathToFileURL } from "node:url";

const FAPI_BASES = ["https://fapi.binance.com", "https://fapi.binance.vision"];
const TIMEOUT_MS = 10_000;

// 代理仅由环境变量显式开启（只认 http/https 代理，避免 socks 冲突）；未设置则直连
const PROXY_ENV = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
const PROXY = /^https?:\/\//i.test(PROXY_ENV) ? PROXY_ENV : "";
const proxyAgent = PROXY ? new ProxyAgent(PROXY) : null;

/**
 * 获取 Binance USDT 永续 24h 成交额 Top N（含杠杆代币，纯成交量排序）。
 * 支持排除名单：先按成交量排序，再剔除 exclude 中的合约，取前 N（若被排除者在 N 内，由后续补位）。
 * @param {number} [n=10] 返回数量
 * @param {Object} [opts]
 * @param {string[]} [opts.exclude=[]] 排除的合约（如不想监控的币种）
 * @returns {Promise<Array<{symbol: string, quoteVolume: number, lastPrice: number}>>}
 */
export async function getTopVolumeSymbols(n = 10, { exclude = [] } = {}) {
  const tickers = await fetchTicker24h();
  const excludeSet = new Set(exclude);
  const usdtPerps = tickers
    .filter((t) => t.symbol.endsWith("USDT"))
    .filter((t) => !excludeSet.has(t.symbol))
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume));
  return usdtPerps.slice(0, n).map((t) => ({
    symbol: t.symbol,
    quoteVolume: Number(t.quoteVolume),
    lastPrice: Number(t.lastPrice),
  }));
}

/** 拉取全部永续 24h ticker（有代理则代理 → 直连兜底；无代理直接直连）。
 *  注意：必须用 undici.request 而非 fetch —— undici 8.10 的 fetch + ProxyAgent 存在
 *  UND_ERR_INVALID_ARG 兼容 bug，request API 正常。 */
async function fetchTicker24h() {
  const modes = PROXY
    ? [
        { name: "proxy", opts: { dispatcher: proxyAgent } },
        { name: "direct", opts: {} },
      ]
    : [{ name: "direct", opts: {} }];
  let lastErr;
  for (const base of FAPI_BASES) {
    for (const mode of modes) {
      try {
        const url = `${base}/fapi/v1/ticker/24hr`;
        const { statusCode, body } = await request(url, {
          ...mode.opts,
          headersTimeout: TIMEOUT_MS,
          bodyTimeout: TIMEOUT_MS,
        });
        if (statusCode !== 200) throw new Error(`HTTP ${statusCode}`);
        const data = JSON.parse(await body.text());
        if (!Array.isArray(data)) throw new Error("响应格式异常");
        return data.map((t) => ({
          symbol: t.symbol,
          quoteVolume: Number(t.quoteVolume),
          lastPrice: Number(t.lastPrice),
        }));
      } catch (e) {
        lastErr = e;
      }
    }
  }
  throw new Error(`获取 24h ticker 失败: ${lastErr && lastErr.message}`);
}

// CLI：node monitor/topVolume.js [N]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const n = Number(process.argv[2]) || 10;
  getTopVolumeSymbols(n)
    .then((list) => {
      console.log(`# ${n} USDT 永续 24h 成交额 Top（单位: 10亿 USDT）\n`);
      list.forEach((t, i) => {
        const vol = (t.quoteVolume / 1e9).toFixed(2);
        console.log(`${String(i + 1).padStart(2)}. ${t.symbol.padEnd(16)} ${vol} B  last ${t.lastPrice}`);
      });
    })
    .catch((e) => {
      console.error(`[topVolume] 失败: ${e.message}`);
      process.exit(1);
    });
}
