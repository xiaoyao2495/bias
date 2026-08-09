/**
 * pdArray.js — PD Array：FVG 与 Order Block
 *
 * FVG（三根 K）：定义正确，保持。
 *   Bullish FVG : K1.high < K3.low  → 向上缺口，top = K3.low, bottom = K1.high
 *   Bearish FVG : K1.low  > K3.high → 向下缺口，top = K1.low,  bottom = K3.high
 *
 * Order Block：ICT 2022 定义 OB = 导致 Displacement / MSS / BOS 的根 K 的前一根（机构推动起点）。
 *   V2.0：优先用位移 K 关联生成（displacement: true，标记质量更高）；原简化规则（阴线后强阳突破 /
 *   阳线后强阴跌破）保留为 fallback，与位移 OB 区间重叠的跳过。不参与 Bias（仅执行区/展示）。
 *
 * V1.6：FVG/OB 增加 direction / age / location / status（OPEN-FILLED），并新增 rankPDArray
 *   用于把 PD Array 作为"执行区域"（不参与 bias 判定）：同向 + 在顺位一侧 → VALID Primary。
 */

/** 找出所有 FVG */
export function findFvgs(candles) {
  const fvgs = [];
  for (let i = 2; i < candles.length; i++) {
    const k1 = candles[i - 2];
    const k3 = candles[i];
    if (k3.low > k1.high) {
      fvgs.push({ type: "BULLISH_FVG", direction: "BULLISH", top: k3.low, bottom: k1.high, index: i, time: candles[i - 1].time });
    }
    if (k1.low > k3.high) {
      fvgs.push({ type: "BEARISH_FVG", direction: "BEARISH", top: k1.low, bottom: k3.high, index: i, time: candles[i - 1].time });
    }
  }
  return fvgs;
}

/**
 * 找出所有 Order Block，并按 ICT 2022（L4）细分：
 *   kind  = STANDARD | BREAKER | REJECTION
 *     BREAKER  ：OB 形成后被收盘穿透（BULLISH_OB 收破下沿 / BEARISH_OB 收破上沿），
 *                且之后又收盘收回 OB 区间 → 原支撑/阻力角色反转（Breaker Block）
 *     REJECTION：OB 所在 K 自带长影线（BULLISH_OB 长下影 / BEARISH_OB 长上影）→ 机构在该区域拒绝
 *   state = FRESH | USED
 *     后续任一根 K 回踩过 OB 区间 → USED（已消费），否则 FRESH（未访问，效力更强）
 */
import { findDisplacements } from "./displacement.js";

/**
 * 生成一个 OB（共用：位移驱动 / fallback 简化规则都走这里）。
 * @param {Array} candles 完整 K 线（用于后续 K 的穿透/回踩判定）
 * @param {Object} prev OB 所在 K（其 high/low 构成 OB 区间）
 * @param {number} i OB 确认 K 的索引（后续扫描从 i 开始，含确认 K 自身）
 * @param {"BULLISH_OB"|"BEARISH_OB"} type
 * @param {boolean} bullish true=BULLISH_OB
 * @param {boolean} displacement true=由位移 K 驱动生成
 */
function buildOb(candles, prev, i, type, bullish, displacement) {
  const high = prev.high;
  const low = prev.low;
  const body = Math.abs(prev.close - prev.open);

  // 后续 K：穿透后收回（BREAKER）+ 是否被回踩（USED）
  let broken = false;
  let recovered = false;
  let used = false;
  for (let j = i; j < candles.length; j++) {
    const k = candles[j];
    if (k.low <= high && k.high >= low) used = true; // 价格访问过 OB 区间
    if (bullish) {
      if (!broken && k.close < low) broken = true; // 收盘跌破 OB 下沿（穿透）
      else if (broken && k.close >= low) recovered = true; // 之后收盘收回 OB 内/上方
    } else {
      if (!broken && k.close > high) broken = true; // 收盘涨破 OB 上沿（穿透）
      else if (broken && k.close <= high) recovered = true; // 之后收盘收回 OB 内/下方
    }
  }
  // 影线拒绝：BULLISH_OB 看长下影（下方抛压被拒回），BEARISH_OB 看长上影
  const reject = body > 0
    ? bullish
      ? Math.min(prev.open, prev.close) - prev.low >= 2 * body
      : prev.high - Math.max(prev.open, prev.close) >= 2 * body
    : false;
  const kind = broken && recovered ? "BREAKER" : reject ? "REJECTION" : "STANDARD";

  return {
    type,
    direction: bullish ? "BULLISH" : "BEARISH",
    high,
    low,
    index: i,
    time: prev.time,
    experimental: true,
    confirmed: true,
    kind,
    state: used ? "USED" : "FRESH",
    displacement,
  };
}

/**
 * 找出所有 Order Block（ICT 2022：OB = 导致 Displacement 的 K 的前一根）。
 *   - 优先：位移 K（displacement.js 三条件）的前一根 → OB，标记 displacement: true
 *   - fallback：简化规则（阴线后强阳突破 / 阳线后强阴跌破），与位移 OB 区间重叠的跳过
 * kind = STANDARD | BREAKER | REJECTION；state = FRESH | USED（语义见 buildOb）
 */
export function findOrderBlocks(candles) {
  const obs = [];

  // 1) 位移驱动 OB：UP 位移 → 前一根 BULLISH_OB；DOWN 位移 → 前一根 BEARISH_OB
  const dispList = findDisplacements(candles);
  const timeToIndex = new Map();
  for (let i = 0; i < candles.length; i++) timeToIndex.set(candles[i].closeTime, i);
  for (const d of dispList) {
    const idx = timeToIndex.get(d.time);
    if (idx == null || idx <= 0) continue;
    const prev = candles[idx - 1];
    const bullish = d.direction === "UP";
    obs.push(buildOb(candles, prev, idx, bullish ? "BULLISH_OB" : "BEARISH_OB", bullish, true));
  }

  // 2) fallback 简化规则：阴线后强阳突破 / 阳线后强阴跌破（与位移 OB 区间重叠的跳过，避免重复标注）
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const cur = candles[i];

    const prevBearish = prev.close < prev.open;
    const prevBullish = prev.close > prev.open;
    const curBullish = cur.close > cur.open;
    const curBearish = cur.close < cur.open;

    const bullish = prevBearish && curBullish && cur.close > prev.high;
    const bearish = prevBullish && curBearish && cur.close < prev.low;
    if (!bullish && !bearish) continue;
    // 与位移 OB 区间重叠 → 已由位移驱动生成，跳过 fallback
    const dup = obs.some((o) => o.displacement && o.low <= prev.high && prev.low <= o.high);
    if (dup) continue;

    obs.push(buildOb(candles, prev, i, bullish ? "BULLISH_OB" : "BEARISH_OB", bullish, false));
  }
  return obs;
}

/**
 * V1.6：给 FVG/OB 标注执行属性。
 *   location：区间中点相对 dealing range 中线 → PREMIUM / DISCOUNT / AT_EQ
 *   age     ：距当前 K 的根数（越小越新）
 *   status ：
 *     FVG 四态（P1 语义修正：CE 是触及中点，FILLED 才是触及远端；消耗单向递增不降级）——
 *       OPEN      未进入缺口（Bullish: low 恒 > top；Bearish: high 恒 < bottom）
 *       TOUCHED   进入缺口但未到中点（Bullish: low ≤ top 且 low > mid；Bearish 对称）
 *       CE_REACHED触及中点（Bullish: low ≤ mid；Bearish: high ≥ mid）
 *       FILLED    触及远端（Bullish: low ≤ bottom；Bearish: high ≥ top）＝缺口完全回补＝彻底失效
 *     消耗深度由整个形成后区间的最深触及一次性决定，只允许升级、不允许降级
 *     （先触及中点后浅回踩的 FVG 不得从 CE_REACHED 降回 TOUCHED）。
 *     OB 两态（无"填补"概念，保持原语义）：OPEN / FILLED（价格回到区间）
 */
export function annotatePDArray(pdArray, range, candles) {
  const currentIndex = candles.length - 1;
  const eq = range && range.equilibrium;

  const annotate = (item) => {
    const mid = (item.top + item.bottom) / 2;
    const location = eq == null ? null : mid > eq ? "PREMIUM" : mid < eq ? "DISCOUNT" : "AT_EQ";
    const age = currentIndex - item.index;
    let status = "OPEN";
    if (item.type === "BULLISH_FVG") {
      // P1：消耗深度由整个形成后区间的最低 low 一次性决定（单向递增，OPEN < TOUCHED < CE_REACHED < FILLED）。
      // 逐根覆盖会让"先触及中点后浅回踩"的 FVG 从 CE_REACHED 降回 TOUCHED（扣分 −15 回升 −10）。
      let deepest = Infinity;
      for (let i = item.index + 1; i <= currentIndex; i++) deepest = Math.min(deepest, candles[i].low);
      if (deepest <= item.bottom) status = "FILLED"; // 触及远端 = 完全回补
      else if (deepest <= mid) status = "CE_REACHED"; // 触及中点
      else if (deepest <= item.top) status = "TOUCHED"; // 仅进入缺口（未到中点）
    } else if (item.type === "BEARISH_FVG") {
      // P1：对称——消耗深度由整个形成后区间的最高 high 一次性决定
      let deepest = -Infinity;
      for (let i = item.index + 1; i <= currentIndex; i++) deepest = Math.max(deepest, candles[i].high);
      if (deepest >= item.top) status = "FILLED"; // 触及远端 = 完全回补
      else if (deepest >= mid) status = "CE_REACHED"; // 触及中点
      else if (deepest >= item.bottom) status = "TOUCHED"; // 仅进入缺口（未到中点）
    } else {
      for (let i = item.index + 1; i <= currentIndex; i++) {
        if (candles[i].low <= item.high && candles[i].high >= item.low) { status = "FILLED"; break; }
      }
    }
    return { ...item, location, age, status };
  };

  return {
    fvg: (pdArray.fvg || []).map(annotate),
    ob: (pdArray.ob || []).map(annotate),
  };
}

/**
 * V1.6：PD Array Ranking（执行区域，不参与 bias）。
 * 规则：
 *   - 方向与 bias 相反 → Ignore（排除）
 *   - 同向且在顺位一侧（Bullish: DISCOUNT；Bearish: PREMIUM）→ VALID，进 Primary/Alternative
 *   - 同向但在逆位一侧 → COUNTER_LOCATION（低分，仅作备选展示）
 * 评分：同向 +60，顺位 +30，逆位 -20，已填充 -25。FVG 参考价=顺位侧端点（Bullish bottom / Bearish top），OB 同理。
 */
export function rankPDArray({ bias, range, pdArray }) {
  const eq = range && range.equilibrium;
  const isBuyBias = bias === "BULLISH";
  const items = [...(pdArray.fvg || []), ...(pdArray.ob || [])];

  const candidates = [];
  for (const item of items) {
    if (item.direction !== bias) continue; // 反向 → Ignore

    // P1：FVG 触及远端（FILLED）＝缺口完全回补，彻底失效 → 不进入候选，
    // 不能成为 Primary/Alternative（否则已失效 FVG 仍被当作执行目标抬高 Confidence）。
    // OB 的 FILLED（价格回到区间）≠ 失效，仍保留低分参与。
    if (item.type.includes("FVG") && item.status === "FILLED") continue;

    const top = item.top ?? item.high; // OB 项用 high/low
    const bottom = item.bottom ?? item.low;
    const mid = (top + bottom) / 2;
    const loc = eq == null ? null : mid > eq ? "PREMIUM" : mid < eq ? "DISCOUNT" : "AT_EQ";
    const inFavor = isBuyBias ? loc === "DISCOUNT" : loc === "PREMIUM";

    let score = 60 + (inFavor ? 30 : -20);
    // P1：FVG 消耗分级扣分——FILLED（已触及远端）在 rankPDArray 已排除；
    // CE_REACHED（触及中点）/TOUCHED（进入未到中点）仍保留参考价值，按消耗程度扣分
    if (item.status === "FILLED") score -= 25; // 仅 OB（FVG FILLED 已排除）
    else if (item.status === "CE_REACHED") score -= 15;
    else if (item.status === "TOUCHED") score -= 10;
    if (item.age > 60) score -= 10; // 太旧的执行区价值低

    candidates.push({
      type: item.type,
      price: item.type === "BULLISH_FVG" || item.type === "BULLISH_OB" ? bottom : top,
      top,
      bottom,
      score,
      location: loc,
      status: inFavor ? "VALID" : "COUNTER_LOCATION",
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const primary = candidates.find((c) => c.status === "VALID") || null;
  const alternatives = candidates.filter((c) => c !== primary).map(({ type, price, top, bottom, location, status }) => ({ type, price, top, bottom, location, status }));

  return { primary, alternatives };
}
