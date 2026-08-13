/**
 * killzone.js — 活跃成交量窗口 + ICT Session 标注
 *
 * ICT 2022 Killzone 是固定的纽约当地钟表时段。加密市场（尤其美股相关代币，如
 * SNDK/SOXL/MU/KORU 等）的实际活跃时段随标的资产交易时段漂移——例如美股代币的
 * 真实高峰在北京 20:00-24:00（美东 9:30-16:00），与课程"伦敦 14:00-17:00"错位。
 *
 * 因此这里额外提供**数据驱动活跃窗口**：用该合约真实 1h 成交量（USDT 成交额）
 * 按北京时间小时聚合。它是工程统计指标，不等同于 ICT 固定 Killzone。
 *
 * 判定规则：
 *   computeActiveWindows(h1) — 输入 1h K 线（含 quoteVol），输出活跃窗口
 *     [{ start, end, ratio }]（start/end 为北京时间小时，半开区间；ratio=窗口成交量占比%）
 *     活跃小时 = 该小时成交量 > 全天均值 × factor（默认 1.5），合并连续小时为窗口；
 *     窗口占比 < 10%（不足全天 1/10）的窗口视为碎片丢弃。
 *     factor 用 1.5（而非 1.2）：三币上周实盘验证（BTC/SNDK/MU），1.2×均值 ≈ 5% 会把
 *     5-6% 的次级小峰（如 BTC 06/09 点、MU 08 点）误判为"活跃窗口"，与 15-17% 主峰
 *     同等待遇，产生碎片窗口误导 Session 展示；1.5×均值（≈6.25%）下碎片消失、主峰完整保留。
 *   activeVolumeWindowAt(time, windows) — 仅按事件当前时刻判定，避免整根 4H K 提前命中未来窗口
 *   ictSessionAt(time) — 按纽约当地时间标注 ICT Asia/London/New York Killzone，不参与成交量评分
 *
 * 兼容性：旧缓存 K 线无 quoteVol 字段（视为 0）→ 无数据时返回 []。
 */

const BJ_OFFSET_MS = 8 * 3600_000;
const DAY_MS = 24 * 3600_000;
/** 碎片窗口过滤：窗口成交量占比 < 10%（不足全天 1/10）视为噪声丢弃（见 computeActiveWindows） */
const WINDOW_MIN_RATIO = 10;

/** ms → 北京时间小时（小数） */
function bjHour(ms) {
  const d = new Date(ms + BJ_OFFSET_MS);
  return d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
}

/** 当前事件时刻是否位于某个数据驱动活跃窗口。窗口是北京时间小时半开区间。 */
export function activeVolumeWindowAt(time, windows) {
  if (!Number.isFinite(Number(time)) || !windows || !windows.length) return null;
  const hour = bjHour(Number(time));
  for (const w of windows) {
    const inside = w.start < w.end
      ? hour >= w.start && hour < w.end
      : hour >= w.start || hour < w.end;
    if (inside) return { ...w, kind: "ACTIVE_VOLUME_WINDOW" };
  }
  return null;
}

/**
 * ICT 固定时段标注（纽约当地钟表时间，DST 由 IANA 时区自动处理）。
 * 只提供课程语境，不与数据驱动活跃窗口混用：Asia 20:00-00:00、London 02:00-05:00、
 * New York 07:00-10:00（America/New_York）。
 */
export function ictSessionAt(time) {
  if (!Number.isFinite(Number(time))) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(Number(time)));
  const value = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const minutes = Number(value.hour) * 60 + Number(value.minute);
  if (minutes >= 20 * 60) return { name: "ASIA", label: "ICT Asia Killzone", timeZone: "America/New_York" };
  if (minutes >= 2 * 60 && minutes < 5 * 60) return { name: "LONDON", label: "ICT London Killzone", timeZone: "America/New_York" };
  if (minutes >= 7 * 60 && minutes < 10 * 60) return { name: "NEW_YORK", label: "ICT New York Killzone", timeZone: "America/New_York" };
  return null;
}

/**
 * 过滤最近一个完整交易周（北京时间周一 00:00 ~ 周五 24:00）的 1h K 线。
 * 活跃窗口只用上周一~五数据：排除周末（加密市场周末量低，且美股代币标的休市），
 * 且用近期周更能反映当前活跃时段（比 30 天历史权重更贴近现状）。
 * 每周一刷新一次（1h 缓存 TTL 一周，见 data/binance.js TTL_OVERRIDE_MIN["1h"]）。
 * @param {Array} h1 1h K 线（{time}，任意天数）
 * @param {number} [now=Date.now()] 测试可注入
 * @returns {Array} 落在上周一 00:00（北京）~ 上周五 24:00（北京）的 K
 */
export function lastTradingWeek(h1, now = Date.now()) {
  if (!h1 || !h1.length) return [];
  const bjNow = new Date(now + BJ_OFFSET_MS);
  const dow = bjNow.getUTCDay(); // 0=周日
  const daysBackToMon = (dow + 6) % 7; // 距最近周一 00:00 的天数（今天周一=0）
  const today00BjUtc = Date.UTC(bjNow.getUTCFullYear(), bjNow.getUTCMonth(), bjNow.getUTCDate()) - BJ_OFFSET_MS; // 北京今天 00:00（UTC ms）
  const thisMon00 = today00BjUtc - daysBackToMon * DAY_MS; // 本周一 00:00（北京，UTC ms）
  const lastMon00 = thisMon00 - 7 * DAY_MS; // 上周一 00:00（北京）
  const lastFriEnd = lastMon00 + 5 * DAY_MS; // 上周五 24:00（北京）
  return h1.filter((k) => k.time >= lastMon00 && k.time < lastFriEnd);
}

/**
 * 由 1h K 线计算该合约的活跃成交量窗口。
 * @param {Array} h1 1h K 线（{time, quoteVol}，时间升序，任意天数——越久分布越稳）
 * @param {Object} [opt]
 * @param {number} [opt.factor=1.5] 活跃阈值：小时成交量 > 全天均值 × factor 记为活跃
 *   1.5 为数据实证值（1.2 会把 5-6% 次级小峰误判为活跃窗口，见文件头注释）
 * @returns {Array<{start:number, end:number, ratio:number}>} 活跃窗口（北京小时半开区间），按占比降序
 */
export function computeActiveWindows(h1, { factor = 1.5 } = {}) {
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
  // 碎片过滤：占比 < 10%（不足全天 1/10）的窗口视为次级小峰
  // 碎片丢弃（实盘：XAG 02-03 点 7%、09-10 点 6.3% 相对主峰 17% 是噪声；factor 再提会
  // 误杀部分主峰尾部小时，如 BTC 23 点 5.9%）。真实主峰窗口（21-23 占 17-41%）不受影响。
  return windows.filter((w) => w.ratio >= WINDOW_MIN_RATIO);
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
