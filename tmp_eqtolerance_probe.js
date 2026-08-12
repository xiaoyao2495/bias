/**
 * tmp_eqtolerance_probe.js — EQH/EQL 容差敏感性探针（P2 决策用，一次性脚本）
 *
 * 目标：验证 0.2% 固定容差在不同波动率币种上是否失效。
 * 统计口径：
 *   - 近 150 根 4H 内 HIGH/LOW swing 数量
 *   - 相邻同类 swing 的相对间距分布（P50/P75/P90）——自然间距远大于容差 ⇒ 无法聚类 ⇒ 识别失效
 *   - 容差 0.2% / 0.5% / 1.0% 下的聚类簇数（≥2 成员）与最大簇 touches
 *   - 4H ATR（近 14 根 high-low 均值）/价格 作为波动率参考
 *
 * 用法（本地需代理）：HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 \
 *   node tmp_eqtolerance_probe.js
 */
import { getHistory } from "./data/binance.js";
import { findSwings, analyzeSwings } from "./indicators/swing.js";

const SYMBOLS = ["BTCUSDT", "SOLUSDT", "DOGEUSDT", "MUUSDT", "SNDKUSDT", "XAUUSDT"];
const EQ_LOOKBACK_BARS = 150;

/** 并查集聚类（与 liquidity.js clusterByPrice 同语义）：两两价格在容差内视为同簇 */
function clusterSwings(swings, type, tolerance) {
  const items = swings.filter((s) => s.type === type).map((s) => ({ price: s.price, index: s.index }));
  if (items.length < 2) return { clusters: 0, maxTouches: 0, maxSpanPct: 0 };
  const parent = items.map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (Math.abs(items[i].price - items[j].price) / Math.max(items[i].price, items[j].price) <= tolerance) {
        parent[find(i)] = find(j);
      }
    }
  }
  const groups = new Map();
  items.forEach((it, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(it);
  });
  const clusters = [...groups.values()].filter((g) => g.length >= 2);
  // 最大簇跨度（簇内最高-最低 相对差 %）：判断该容差是否把"接近但不相等"的高点宽泛合并（误报）
  let maxTouches = 0;
  let maxSpanPct = 0;
  for (const g of clusters) {
    if (g.length > maxTouches) maxTouches = g.length;
    const span = (Math.max(...g.map((x) => x.price)) - Math.min(...g.map((x) => x.price))) / Math.max(...g.map((x) => x.price));
    if (span > maxSpanPct) maxSpanPct = span;
  }
  return { clusters: clusters.length, maxTouches, maxSpanPct: maxSpanPct * 100 };
}

/** 相邻同类 swing 的相对间距分布 */
function gapDist(swings, type) {
  const ps = swings.filter((s) => s.type === type).map((s) => s.price);
  if (ps.length < 2) return null;
  const gaps = [];
  for (let i = 1; i < ps.length; i++) {
    if (ps[i] > 0) gaps.push(Math.abs(ps[i] - ps[i - 1]) / ps[i]);
  }
  gaps.sort((a, b) => a - b);
  const q = (p) => gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))];
  return { n: ps.length, p50: q(0.5), p75: q(0.75), p90: q(0.9) };
}

async function probe(symbol) {
  const [h4, daily, weekly, h1] = await Promise.all([
    getHistory(symbol, "4h", 500),
    getHistory(symbol, "1d", 30),
    getHistory(symbol, "1w", 20),
    getHistory(symbol, "1h", 200),
  ]);
  const now = Date.now();
  const closed = h4.filter((k) => k.closeTime <= now);
  const swings = analyzeSwings(findSwings(closed));
  const maxIdx = swings.length ? swings[swings.length - 1].index : 0;
  const recent = swings.filter((s) => s.index >= maxIdx - EQ_LOOKBACK_BARS + 1);

  // 4H ATR%（近 14 根）
  const price = closed[closed.length - 1].close;
  const trs = closed.slice(-14).map((k) => k.high - k.low);
  const atrPct = (trs.reduce((a, b) => a + b, 0) / trs.length / price) * 100;

  const gh = gapDist(recent, "HIGH");
  const gl = gapDist(recent, "LOW");
  const tol = (t) => ({
    h: clusterSwings(recent, "HIGH", t),
    l: clusterSwings(recent, "LOW", t),
  });
  const t02 = tol(0.002);
  const t04 = tol(0.004);
  const t05 = tol(0.005);

  const fmtG = (g) => (g ? `${g.n}·${(g.p50 * 100).toFixed(2)}/${(g.p75 * 100).toFixed(2)}/${(g.p90 * 100).toFixed(2)}%` : "-");
  const fmtC = (c) => `${c.clusters}簇/${c.maxTouches}触/跨度${c.maxSpanPct.toFixed(2)}%`;

  console.log(
    `${symbol.padEnd(9)} 价 ${String(price).padStart(10)}  ATR ${atrPct.toFixed(2).padStart(6)}%  ` +
      `HIGH间距 ${fmtG(gh)}  LOW间距 ${fmtG(gl)}  ` +
      `EQ@0.2% H${fmtC(t02.h)} L${fmtC(t02.l)}  ` +
      `EQ@0.4% H${fmtC(t04.h)} L${fmtC(t04.l)}  ` +
      `EQ@0.5% H${fmtC(t05.h)} L${fmtC(t05.l)}`
  );
  void h1;
  void daily;
  void weekly;
}

for (const s of SYMBOLS) {
  try {
    await probe(s);
  } catch (e) {
    console.log(`${s.padEnd(9)} 失败: ${e.message}`);
  }
}
