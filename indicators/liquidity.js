/**
 * liquidity.js — 流动性目标：PDH/PDL、PWH/PWL、EQH/EQL
 *
 * 输出：
 *   {
 *     buySide:  [{ type: "PDH"|"PWH"|"EQH", price, touches?, firstIndex?, lastIndex? }...], // 上方（买方）流动性，按价格从高到低
 *     sellSide: [{ type: "PDL"|"PWL"|"EQL", price, touches?, firstIndex?, lastIndex? }...], // 下方（卖方）流动性，按价格从低到高
 *     primaryBuyDraw:  { type, price } | null,  // 上方主 Draw（按 ICT 优先级 PWH > PDH > EQH）
 *     primarySellDraw: { type, price } | null,  // 下方主 Draw（按 ICT 优先级 PWL > PDL > EQL）
 *   }
 *
 * EQH / EQL：两个以上接近的 Swing High / Low（误差默认 0.2%）视为等高点。
 *   只统计近端 swing（默认最近 150 根 4H ≈ 25 天），避免把历史价位区间的
 *   摆动点聚出"远高于现价"的假等低点（Case Replay 审计发现）。
 *   额外记录形成时间信息：touches（触点数量）、firstIndex / lastIndex（在 4H K 线中的位置），
 *   因为 ICT 流动性中"时间"很重要（越近的等高点越有效）。
 */

const EQ_TOLERANCE = 0.002; // 0.2%
const EQ_LOOKBACK_BARS = 150; // EQH/EQL 只统计最近 150 根 4H K 线的 swing（≈25 天）
const BUY_PRIORITY = ["PWH", "PDH", "EQH"]; // ICT Draw on Liquidity 优先级（不含 external/internal swing，见 rankLiquidityTargets）
const SELL_PRIORITY = ["PWL", "PDL", "EQL"];

// V1.5：目标类型的人类可读 reason
const TYPE_REASON = {
  PWH: "Previous Week High (HTF objective)",
  PDH: "Previous Day High",
  EQH: "Equal Highs (liquidity cluster)",
  PWL: "Previous Week Low (HTF objective)",
  PDL: "Previous Day Low",
  EQL: "Equal Lows (liquidity cluster)",
};

/**
 * V1.5 Liquidity Audit：按 ICT 优先级挑选主 Draw 与备选目标。
 *
 *   Bullish（BSL，目标在价格上方）：
 *     1. External High（外部结构高点，未突破前是首要目标）
 *     2. PWH  3. PDH  4. EQH  5. Internal High（内部摆动高点）
 *   Bearish（SSL，目标在价格下方）：
 *     1. External Low  2. PWL  3. PDL  4. EQL  5. Internal Low
 *
 * @param {Object} structure  buildStructure() 输出（externalSwingHigh/Low、lastHigh/lastLow）
 * @param {Object} liquidity  computeLiquidity() 输出（buySide / sellSide）
 * @param {"BULLISH"|"BEARISH"} direction
 * @param {number} price      当前价；用于过滤"已在错误方向一侧"的目标（为 null 时不过滤）
 * @returns {{ primary: {type,price,priority,reason}|null, alternatives: [{type,price}] }}
 */
export function rankLiquidityTargets(structure, liquidity, direction, price) {
  const isBuy = direction === "BULLISH";
  const inSide = (p) => price == null || (isBuy ? p > price : p < price);
  const candidates = [];

  // 1. External 结构位（最高优先）
  const ext = isBuy ? structure && structure.externalSwingHigh : structure && structure.externalSwingLow;
  if (ext != null && inSide(ext)) {
    candidates.push({
      type: isBuy ? "EXTERNAL_HIGH" : "EXTERNAL_LOW",
      price: ext,
      priority: 1,
      reason: isBuy ? "External swing high (HTF objective)" : "External swing low (HTF objective)",
    });
  }

  // 2-4. PWH/PDH/EQH 或 PWL/PDL/EQL
  const pool = (isBuy ? liquidity.buySide : liquidity.sellSide).filter((x) => inSide(x.price));
  const priorityList = isBuy ? BUY_PRIORITY : SELL_PRIORITY;
  for (const t of priorityList) {
    const found = pool.find((x) => x.type === t);
    if (found) {
      candidates.push({ type: t, price: found.price, priority: priorityList.indexOf(t) + 2, reason: TYPE_REASON[t] });
    }
  }

  // 5. Internal swing（最近摆动高低点，去重：与外部位/已选目标价格接近的跳过）
  const lastSwing = isBuy ? structure && structure.lastHigh : structure && structure.lastLow;
  if (lastSwing && inSide(lastSwing.price)) {
    const nearDup = candidates.some((c) => Math.abs(c.price - lastSwing.price) / lastSwing.price < 0.0005);
    if (!nearDup) {
      candidates.push({
        type: isBuy ? "INTERNAL_HIGH" : "INTERNAL_LOW",
        price: lastSwing.price,
        priority: 5,
        reason: isBuy ? "Internal swing high" : "Internal swing low",
      });
    }
  }

  const sorted = candidates.sort((a, b) => a.priority - b.priority);
  const primary = sorted[0] || null;
  const alternatives = sorted
    .slice(1)
    .sort((a, b) => (isBuy ? a.price - b.price : b.price - a.price)) // 从近到远
    .map(({ type, price }) => ({ type, price }));

  return { primary, alternatives };
}

/** 最近已收盘的一根 K（closeTime <= now）；now 默认当前时间，回放时可注入历史时间 */
function lastCompleted(candles, now = Date.now()) {
  if (!candles || candles.length === 0) return null;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].closeTime && candles[i].closeTime <= now) return candles[i];
  }
  // 全部未收盘的兜底：取倒数第二根（仅实盘场景会触发）
  return candles[candles.length - 2] || candles[candles.length - 1];
}

/**
 * @param {Array} dailyKlines  日 K 线（data/binance.js 输出）
 * @param {Array} weeklyKlines 周 K 线
 * @param {Array} swings        4H 摆动点（findSwings 输出，时间升序）
 * @param {number} tolerance    等高点容差（0.2% 默认）
 * @param {number} now          参考时间（ms）。回放时传历史时间，只认该时间前已收盘的日/周 K
 * @param {number} eqLookbackBars EQH/EQL 回看窗口（根 4H K 线，默认 150）
 */
export function computeLiquidity(dailyKlines, weeklyKlines, swings, tolerance = EQ_TOLERANCE, now = Date.now(), eqLookbackBars = EQ_LOOKBACK_BARS) {
  const buySide = [];
  const sellSide = [];

  const prevDay = lastCompleted(dailyKlines, now);
  if (prevDay) {
    buySide.push({ type: "PDH", price: prevDay.high });
    sellSide.push({ type: "PDL", price: prevDay.low });
  }

  const prevWeek = lastCompleted(weeklyKlines, now);
  if (prevWeek) {
    buySide.push({ type: "PWH", price: prevWeek.high });
    sellSide.push({ type: "PWL", price: prevWeek.low });
  }

  // EQH/EQL 只取近端 swing（按 4H K 线 index 回看）
  const maxIdx = swings.length ? swings[swings.length - 1].index : 0;
  const recentSwings = swings.filter((s) => s.index >= maxIdx - eqLookbackBars + 1);

  const eqh = findEqualHighs(recentSwings, tolerance);
  if (eqh) buySide.push({ type: "EQH", ...eqh });

  const eql = findEqualLows(recentSwings, tolerance);
  if (eql) sellSide.push({ type: "EQL", ...eql });

  buySide.sort((a, b) => b.price - a.price); // 上方目标：最高的排最前
  sellSide.sort((a, b) => a.price - b.price); // 下方目标：最低的排最前

  return {
    buySide,
    sellSide,
    primaryBuyDraw: pickPrimary(buySide, BUY_PRIORITY),
    primarySellDraw: pickPrimary(sellSide, SELL_PRIORITY),
  };
}

/** 按 ICT 优先级挑选主 Draw */
function pickPrimary(list, priority) {
  for (const t of priority) {
    const found = list.find((x) => x.type === t);
    if (found) return found;
  }
  return list[0] || null;
}

/**
 * 等高点聚类（并查集/传递闭包）：两两价格在容差内视为同簇。
 * 返回 { price, touches, firstIndex, lastIndex }，或 null。
 */
function clusterByPrice(items, tolerance, pick) {
  if (items.length < 2) return null;

  const parent = items.map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a, b) => {
    parent[find(a)] = find(b);
  };

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i].price;
      const b = items[j].price;
      if (Math.abs(a - b) / Math.max(a, b) <= tolerance) union(i, j);
    }
  }

  const groups = new Map();
  items.forEach((it, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(it);
  });

  // 取成员最多的一簇；不满足 >=2 则没有等高点
  const best = [...groups.values()].filter((g) => g.length >= 2).sort((a, b) => b.length - a.length)[0];
  if (!best) return null;
  const price = pick === "max" ? Math.max(...best.map((x) => x.price)) : Math.min(...best.map((x) => x.price));
  const indexes = best.map((x) => x.index).sort((a, b) => a - b);
  return { price, touches: best.length, firstIndex: indexes[0], lastIndex: indexes[indexes.length - 1] };
}

export function findEqualHighs(swings, tolerance = EQ_TOLERANCE) {
  const items = swings.filter((s) => s.type === "HIGH").map((s) => ({ price: s.price, index: s.index }));
  return clusterByPrice(items, tolerance, "max");
}

export function findEqualLows(swings, tolerance = EQ_TOLERANCE) {
  const items = swings.filter((s) => s.type === "LOW").map((s) => ({ price: s.price, index: s.index }));
  return clusterByPrice(items, tolerance, "min");
}
