/**
 * analyzeKillzoneVolume.js — 用真实成交量验证 Killzone 时段（临时分析工具）
 *
 * 假设：ICT Killzone = 机构执行大单的流动性高峰 → 高成交量时段。
 * 做法：拉监控 Top N 合约近 N 天 1h K 线（quote volume = USDT 成交额），
 *       按北京时间小时聚合成交量占比，与理论 Killzone 窗口（夏令时）对照。
 *
 * 理论 Killzone（北京时间，夏令时口径，与 indicators/killzone.js 一致）：
 *   亚洲 08-10 / 伦敦 14-17 / 纽约 19-22 / 伦敦收盘 22-24
 *
 * 用法：
 *   node scripts/analyzeKillzoneVolume.js            # Top10 合约，近 30 天
 *   node scripts/analyzeKillzoneVolume.js 5 90       # Top5 合约，近 90 天
 */
import { getTopVolumeSymbols } from "../monitor/topVolume.js";
import { ProxyAgent, request } from "undici";

const FAPI_BASES = ["https://fapi.binance.com", "https://fapi.binance.vision"];
const TIMEOUT_MS = 15_000;
const PROXY_ENV = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
const PROXY = /^https?:\/\//i.test(PROXY_ENV) ? PROXY_ENV : "";
const proxyAgent = PROXY ? new ProxyAgent(PROXY) : null;

/** 理论 Killzone（北京时间，夏令时）：[名称, 起, 止) */
const KZ = [
  { name: "亚洲", start: 8, end: 10 },
  { name: "伦敦", start: 14, end: 17 },
  { name: "纽约", start: 19, end: 22 },
  { name: "伦敦收盘", start: 22, end: 24 },
];

async function fetchKlines1h(symbol, limit) {
  let lastErr;
  for (const base of FAPI_BASES) {
    for (const mode of PROXY ? [{ dispatcher: proxyAgent }, {}] : [{}]) {
      try {
        const url = `${base}/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=${limit}`;
        const { statusCode, body } = await request(url, {
          ...mode,
          headersTimeout: TIMEOUT_MS,
          bodyTimeout: TIMEOUT_MS,
        });
        if (statusCode !== 200) throw new Error(`HTTP ${statusCode}`);
        const data = JSON.parse(await body.text());
        return data.map((k) => ({ time: k[0], quoteVol: Number(k[7]) || 0 })); // quote volume = USDT 成交额
      } catch (e) {
        lastErr = e;
      }
    }
  }
  throw new Error(`${symbol} 1h K线失败: ${lastErr && lastErr.message}`);
}

async function main() {
  const n = Number(process.argv[2]) || 10;
  const days = Number(process.argv[3]) || 30;
  const list = await getTopVolumeSymbols(n, { exclude: ["SOLUSDT"] });
  const limit = days * 24;

  const agg = new Array(24).fill(0); // 全部合约汇总（北京小时）
  const perSymbol = [];
  for (const { symbol } of list) {
    const klines = await fetchKlines1h(symbol, limit);
    const hourVol = new Array(24).fill(0);
    let total = 0;
    for (const k of klines) {
      const h = new Date(k.time + 8 * 3600_000).getUTCHours(); // 北京时间小时
      hourVol[h] += k.quoteVol;
      total += k.quoteVol;
    }
    perSymbol.push({ symbol, hourVol, total });
    for (let h = 0; h < 24; h++) agg[h] += hourVol[h];
  }

  const aggTotal = agg.reduce((a, b) => a + b, 0);
  const pct = (v) => ((v / aggTotal) * 100).toFixed(2) + "%";
  const kzName = (h) => {
    const z = KZ.find((z) => h >= z.start && h < z.end);
    return z ? `  ← ${z.name}` : "";
  };

  console.log(`\nTop${n} 合约（${list.map((s) => s.symbol).join("、")}）`);
  console.log(`近 ${days} 天 1h 成交量（USDT 成交额）按北京时间小时分布（夏令时口径）\n`);

  console.log("== 全部合约汇总 ==");
  console.log("小时 | 占比   | Killzone");
  for (let h = 0; h < 24; h++) console.log(`${String(h).padStart(2)}:00 | ${pct(agg[h]).padStart(6)} |${kzName(h)}`);

  console.log("\n== 理论 Killzone 窗口聚合（全部合约）==");
  let kzSum = 0;
  for (const z of KZ) {
    let s = 0;
    for (let h = z.start; h < z.end; h++) s += agg[h];
    kzSum += s;
    console.log(`${z.name} ${String(z.start).padStart(2)}:00-${z.end}:00  ${pct(s)}`);
  }
  console.log(`非 Killzone（其余时段）             ${pct(aggTotal - kzSum)}`);

  console.log("\n== 各合约 Killzone 窗口聚合（占比）==");
  console.log("合约".padEnd(14) + "亚洲".padStart(8) + "伦敦".padStart(8) + "纽约".padStart(8) + "伦敦收盘".padStart(10) + "非KZ".padStart(8));
  for (const { symbol, hourVol, total } of perSymbol) {
    const kp = (z) => {
      let s = 0;
      for (let h = z.start; h < z.end; h++) s += hourVol[h];
      return ((s / total) * 100).toFixed(1) + "%";
    };
    let nkz = 0;
    for (let h = 0; h < 24; h++) if (!KZ.find((z) => h >= z.start && h < z.end)) nkz += hourVol[h];
    console.log(
      symbol.padEnd(14) +
        kp(KZ[0]).padStart(8) + kp(KZ[1]).padStart(8) + kp(KZ[2]).padStart(8) + kp(KZ[3]).padStart(10) +
        ((nkz / total) * 100).toFixed(1) + "%".padStart(8)
    );
  }

  console.log("\n== 每小时占比 TOP 8（全部合约，说明真实活跃高峰）==");
  const ranked = agg.map((v, h) => ({ h, pct: v / aggTotal })).sort((a, b) => b.pct - a.pct).slice(0, 8);
  for (const r of ranked) {
    const z = KZ.find((z) => r.h >= z.start && r.h < z.end);
    console.log(`${String(r.h).padStart(2)}:00-${String(r.h + 1).padStart(2)}:00  ${(r.pct * 100).toFixed(2)}%  ${z ? `（${z.name} Killzone）` : "（非 Killzone）"}`);
  }
}

main().catch((e) => {
  console.error("失败:", e.message);
  process.exit(1);
});
