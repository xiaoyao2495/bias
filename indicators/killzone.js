/**
 * killzone.js — Killzone（Session）标注：数据驱动版
 *
 * ICT 2022 课程的 Killzone 是"机构执行大单的流动性高峰时段"，本质是高成交量窗口。
 * 但课程固定窗口（纽约本地时间）以外汇为主，加密市场（尤其美股相关代币，如
 * SNDK/SOXL/MU/KORU 等）的实际活跃时段随标的资产交易时段漂移——例如美股代币的
 * 真实高峰在北京 20:00-24:00（美东 9:30-16:00），与课程"伦敦 14:00-17:00"错位。
 *
 * 因此这里改为**数据驱动**：用该合约真实 1h 成交量（USDT 成交额）按北京时间小时
 * 聚合，找出显著高于平均的连续时段作为"活跃窗口"（即该币的真实 Killzone）。
 *
 * 判定规则：
 *   computeActiveWindows(h1) — 输入 1h K 线（含 quoteVol），输出活跃窗口
 *     [{ start, end, ratio }]（start/end 为北京时间小时，半开区间；ratio=窗口成交量占比%）
 *     活跃小时 = 该小时成交量 > 全天均值 × factor（默认 1.2），合并连续小时为窗口。
 *   killzoneOfK(k, windows)  — K 覆盖时段与活跃窗口的重叠时长，取重叠最长者；无 → null
 *
 * 兼容性：旧缓存 K 线无 quoteVol 字段（视为 0）→ 无数据时返回 []，调用方降级为"非 Killzone"。
 */

const BJ_OFFSET_MS = 8 * 3600_000;

/** ms → 北京时间小时（小数） */
function bjHour(ms) {
  const d = new Date(ms + BJ_OFFSET_MS);
  return d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
}

/**
 * 由 1h K 线计算该合约的活跃窗口（真实 Killzone）。
 * @param {Array} h1 1h K 线（{time, quoteVol}，时间升序，任意天数——越久分布越稳）
 * @param {Object} [opt]
 * @param {number} [opt.factor=1.2] 活跃阈值：小时成交量 > 全天均值 × factor 记为活跃
 * @returns {Array<{start:number, end:number, ratio:number}>} 活跃窗口（北京小时半开区间），按占比降序
 */
export function computeActiveWindows(h1, { factor = 1.2 } = {}) {
  if (!h1 || h1.length < 24) return [];
  const hourVol = new Array(24).fill(0);
  const ratio = new Array(24).fill(0);
  let total = 0;
  for (const k of h1) {
    const q = k.quoteVol || 0;
    if (!q) continue;
    const h = new Date(k.time + BJ_OFFSET_MS).getUTCHours();
    hourVol[h] += q;
    total += q;
  }
  if (!total) return [];
  const mean = total / 24;
  const active = new Array(24).fill(false);
  for (let h = 0; h < 24; h++) {
    ratio[h] = hourVol[h] / total;
    if (hourVol[h] > mean * factor) active[h] = true;
  }
  // 合并连续活跃小时为窗口
  const windows = [];
  let i = 0;
  while (i < 24) {
    if (!active[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < 24 && active[j]) j++;
    let s = 0;
    for (let h = i; h < j; h++) s += ratio[h];
    windows.push({ start: i, end: j, ratio: Number((s * 100).toFixed(1)) });
    i = j;
  }
  windows.sort((a, b) => b.ratio - a.ratio);
  return windows;
}

/**
 * K 覆盖时段与活跃窗口的重叠时长，取重叠最长者。
 * @param {Object} k 4H K（{time, closeTime}）
 * @param {Array} windows computeActiveWindows 的输出
 * @returns {{start:number, end:number, ratio:number}|null}
 */
export function killzoneOfK(k, windows) {
  if (!k || k.time == null || k.closeTime == null || !windows || !windows.length) return null;
  const h1 = bjHour(k.time);
  const h2 = bjHour(k.closeTime);
  if (h2 === h1) return null; // 防御：覆盖 0 时长
  // K 覆盖时段可能跨午夜（如北京 20:00-24:00 → h1=20, h2=0）：拆成 [h1,24)+[0,h2] 两段分别算重叠
  const segments = h2 > h1 ? [[h1, h2]] : [[h1, 24], [0, h2]];
  let best = null;
  let bestOv = 0;
  for (const [s, e] of segments) {
    for (const w of windows) {
      const ov = Math.max(0, Math.min(e, w.end) - Math.max(s, w.start));
      if (ov > bestOv) {
        bestOv = ov;
        best = w;
      }
    }
  }
  return bestOv > 0 ? best : null;
}
