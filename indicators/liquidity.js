/**
 * liquidity.js — 流动性目标：PDH/PDL、PWH/PWL、EQH/EQL、盘前区间（PRE_MARKET_HIGH/LOW）
 *
 * 输出：
 *   {
 *     buySide:  [{ type: "PDH"|"PWH"|"PRE_MARKET_HIGH"|"EQH", price, time?, date?, touches?, firstIndex?, lastIndex?, firstTime?, lastTime? }...], // 上方（买方）流动性，按价格从高到低
 *     sellSide: [{ type: "PDL"|"PWL"|"PRE_MARKET_LOW"|"EQL", price, time?, date?, touches?, firstIndex?, lastIndex?, firstTime?, lastTime? }...], // 下方（卖方）流动性，按价格从低到高
 *     primaryBuyDraw:  { type, price } | null,  // 上方主 Draw（按 ICT 优先级 PWH > PDH > PRE_MARKET_HIGH > EQH）
 *     primarySellDraw: { type, price } | null,  // 下方主 Draw（按 ICT 优先级 PWL > PDL > PRE_MARKET_LOW > EQL）
 *   }
 *
 * 形成时间字段（扫损消息"被扫的流动性是什么时候的"用，用户要对照图表定位该位）：
 *   time  — 形成 K 的开盘时间（ms）：PDH/PDL=昨日日 K、PWH/PWL=上周周 K、EQH/EQL=首个触点 4H K、
 *           EXTERNAL=外部 swing 4H K、PRE_MARKET=盘前区间形成极值的那根 1H K
 *   date  — 盘前区间（PRE_MARKET_HIGH/LOW）的北京日期字符串 "YYYY-MM-DD"（无 highTime/lowTime 的兜底）
 *   firstTime/lastTime — EQH/EQL 首个/最后触点的 4H K 开盘时间
 *
 * EQH / EQL：两个以上接近的 Swing High / Low（误差默认 0.2%）视为等高点。
 *   只统计近端 swing（默认最近 150 根 4H ≈ 25 天），避免把历史价位区间的
 *   摆动点聚出"远高于现价"的假等低点（Case Replay 审计发现）。
 *   额外记录形成时间信息：touches（触点数量）、firstIndex / lastIndex（在 4H K 线中的位置），
 *   因为 ICT 流动性中"时间"很重要（越近的等高点越有效）。
 *
 * V2.0 盘前区间（PRE_MARKET_HIGH/LOW）：ICT 2022 Asian Range 在美股代币上的对应物。
 *   美股盘前（北京 16:00-21:30）形成的区间高低是开盘后最常被扫的流动性位，
 *   优先级置于 PDH/PDL 之后、EQH/EQL 之前。需要 1h K 线（analyzeBias 的 h1）计算。
 */

const EQ_TOLERANCE = 0.002; // 0.2%
const EQ_LOOKBACK_BARS = 150; // EQH/EQL 只统计最近 150 根 4H K 线的 swing（≈25 天）
// V2.0：Draw on Liquidity 优先级（不含 external/internal swing，见 rankLiquidityTargets）
const BUY_PRIORITY = ["PWH", "PDH", "PRE_MARKET_HIGH", "EQH"];
const SELL_PRIORITY = ["PWL", "PDL", "PRE_MARKET_LOW", "EQL"];

// V1.5：目标类型的人类可读 reason
const TYPE_REASON = {
  PWH: "Previous Week High (HTF objective)",
  PDH: "Previous Day High",
  PRE_MARKET_HIGH: "Pre-market High (session liquidity)",
  EQH: "Equal Highs (liquidity cluster)",
  PWL: "Previous Week Low (HTF objective)",
  PDL: "Previous Day Low",
  PRE_MARKET_LOW: "Pre-market Low (session liquidity)",
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
  const active = (x) => !x || !x.state || x.state === "ACTIVE";
  const candidates = [];

  // 1. External 结构位（最高优先）
  const ext = isBuy ? structure && structure.externalSwingHigh : structure && structure.externalSwingLow;
  const extState = isBuy ? structure && structure.externalSwingHighState : structure && structure.externalSwingLowState;
  if (ext != null && inSide(ext) && active(extState)) {
    candidates.push({
      type: isBuy ? "EXTERNAL_HIGH" : "EXTERNAL_LOW",
      price: ext,
      priority: 1,
      group: "HTF",
      reason: isBuy ? "External swing high (HTF objective)" : "External swing low (HTF objective)",
    });
  }

  // 2-4. PWH/PDH/EQH 或 PWL/PDL/EQL
  const pool = (isBuy ? liquidity.buySide : liquidity.sellSide).filter((x) => inSide(x.price) && active(x));
  const priorityList = isBuy ? BUY_PRIORITY : SELL_PRIORITY;
  for (const t of priorityList) {
    const found = pool.find((x) => x.type === t);
    if (found) {
      candidates.push({ type: t, price: found.price, priority: priorityList.indexOf(t) + 2, ...(found.group ? { group: found.group } : {}), reason: TYPE_REASON[t] });
    }
  }

  // 5. Internal swing（最近摆动高低点，去重：与外部位/已选目标价格接近的跳过）
  const lastSwing = isBuy ? structure && structure.lastHigh : structure && structure.lastLow;
  const internalState = isBuy ? structure && structure.lastHighState : structure && structure.lastLowState;
  if (lastSwing && inSide(lastSwing.price) && active(internalState)) {
    const nearDup = candidates.some((c) => Math.abs(c.price - lastSwing.price) / lastSwing.price < 0.0005);
    if (!nearDup) {
      candidates.push({
        type: isBuy ? "INTERNAL_HIGH" : "INTERNAL_LOW",
        price: lastSwing.price,
        priority: 5,
        group: "SWING",
        reason: isBuy ? "Internal swing high" : "Internal swing low",
      });
    }
  }

  const sorted = candidates.sort((a, b) => a.priority - b.priority);
  const primary = sorted[0] || null;
  const alternatives = sorted
    .slice(1)
    .sort((a, b) => (isBuy ? a.price - b.price : b.price - a.price)) // 从近到远
    .map(({ type, price, group }) => ({ type, price, ...(group ? { group } : {}) }));

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
 * V2.0 盘前区间（ICT 2022 Asian Range 的美股对应物）：
 *   美股盘前（北京 16:00-21:30，夏令时 EDT 4:00-9:30）形成的区间高低，
 *   是开盘后最常被扫的流动性位（开盘先扫盘前高低 → 再走真方向）。
 *
 * 取"最近一个盘前时段"（now 之前、北京 open 小时 16-21 的 1H K）的最高/最低。
 *   - 无 1h 数据、非美股交易时段（找不到盘前 K）或区间无波动 → null
 *   - 回放：传历史 now，只认 closeTime <= now 的 1H K，幂等
 * @param {Array} [h1] 1H K 线（{time,open,high,low,close,closeTime}，time/closeTime 为 ms）
 * @param {number} [now] 参考时间（ms），默认当前时间
 * @returns {{ high:number, low:number, date:string, bars:number, highTime:number, lowTime:number, activeFrom:number }|null}
 *   highTime/lowTime：盘前区间内形成最高/最低的那根 1H K 的开盘时间（整点），
 *   供扫损消息精确展示"这个盘前位是几点形成的"（仅日期用户在图上找不到）
 */
export function findPremarketRange(h1, now = Date.now()) {
  if (!h1 || !h1.length) return null;
  const BJ = 8 * 3600_000; // 北京时间 = UTC + 8h
  const bjDate = (k) => new Date(k.time + BJ).toISOString().slice(0, 10); // 北京日期
  const bjHour = (k) => new Date(k.time + BJ).getUTCHours(); // 北京小时
  const inWindow = (k) => bjHour(k) >= 16 && bjHour(k) <= 21; // 北京 16:00-21:59（覆盖 21:30 盘前末段）

  const closed = h1.filter((k) => k.closeTime && k.closeTime <= now);
  if (!closed.length) return null;

  // 最近一个盘前时段：从末尾往前找第一根落在盘前窗口的 K 的北京日期
  let date = null;
  for (let i = closed.length - 1; i >= 0; i--) {
    if (inWindow(closed[i])) {
      date = bjDate(closed[i]);
      break;
    }
  }
  if (!date) return null;

  const ks = closed.filter((k) => bjDate(k) === date && inWindow(k));
  if (!ks.length) return null;
  const high = Math.max(...ks.map((k) => k.high));
  const low = Math.min(...ks.map((k) => k.low));
  if (high === low) return null; // 盘前无波动 → 不构成区间
  // 取形成极值的那根 1H K（并列时取最近一根）：扫损消息要精确到"几点形成"
  const highK = [...ks].reverse().find((k) => k.high === high);
  const lowK = [...ks].reverse().find((k) => k.low === low);
  return {
    high,
    low,
    date,
    bars: ks.length,
    highTime: highK ? highK.time : null,
    lowTime: lowK ? lowK.time : null,
    activeFrom: Math.max(...ks.map((k) => k.closeTime || k.time)),
  };
}

/**
 * @param {Array} dailyKlines  日 K 线（data/binance.js 输出）
 * @param {Array} weeklyKlines 周 K 线
 * @param {Array} swings        4H 摆动点（findSwings 输出，时间升序）
 * @param {number} tolerance    等高点容差（0.2% 默认）
 * @param {number} now          参考时间（ms）。回放时传历史时间，只认该时间前已收盘的日/周 K
 * @param {number} eqLookbackBars EQH/EQL 回看窗口（根 4H K 线，默认 150）
 * @param {Array} [h1Klines]    1H K 线（可选）：美股盘前区间（PRE_MARKET_HIGH/LOW）需要
 * @param {Array} [referenceCandles] 已收盘 4H K，用于标记流动性 ACTIVE/SWEPT/BROKEN
 */
export function computeLiquidity(dailyKlines, weeklyKlines, swings, tolerance = EQ_TOLERANCE, now = Date.now(), eqLookbackBars = EQ_LOOKBACK_BARS, h1Klines = null, referenceCandles = null) {
  const buySide = [];
  const sellSide = [];

  const prevDay = lastCompleted(dailyKlines, now);
  if (prevDay) {
    buySide.push({ type: "PDH", price: prevDay.high, time: prevDay.time, group: "HTF", ...(referenceCandles ? { activeFrom: prevDay.closeTime } : {}) });
    sellSide.push({ type: "PDL", price: prevDay.low, time: prevDay.time, group: "HTF", ...(referenceCandles ? { activeFrom: prevDay.closeTime } : {}) });
  }

  const prevWeek = lastCompleted(weeklyKlines, now);
  if (prevWeek) {
    buySide.push({ type: "PWH", price: prevWeek.high, time: prevWeek.time, group: "HTF", ...(referenceCandles ? { activeFrom: prevWeek.closeTime } : {}) });
    sellSide.push({ type: "PWL", price: prevWeek.low, time: prevWeek.time, group: "HTF", ...(referenceCandles ? { activeFrom: prevWeek.closeTime } : {}) });
  }

  // V2.0 盘前区间（需要 1h K 线；不传/非美股时段 → 忽略）
  const premkt = findPremarketRange(h1Klines, now);
  if (premkt) {
    buySide.push({ type: "PRE_MARKET_HIGH", price: premkt.high, date: premkt.date, time: premkt.highTime, group: "SESSION", ...(referenceCandles ? { activeFrom: premkt.activeFrom } : {}) });
    sellSide.push({ type: "PRE_MARKET_LOW", price: premkt.low, date: premkt.date, time: premkt.lowTime, group: "SESSION", ...(referenceCandles ? { activeFrom: premkt.activeFrom } : {}) });
  }

  // EQH/EQL 只取近端 swing（按 4H K 线 index 回看）
  const maxIdx = swings.length ? swings[swings.length - 1].index : 0;
  const recentSwings = swings.filter((s) => s.index >= maxIdx - eqLookbackBars + 1);

  const eqh = findEqualHighs(recentSwings, tolerance);
  if (eqh) buySide.push({ type: "EQH", group: "HTF", ...eqh, ...(referenceCandles ? { activeFrom: candleCloseAt(referenceCandles, eqh.formedIndex) ?? eqh.formedTime } : {}) });

  const eql = findEqualLows(recentSwings, tolerance);
  if (eql) sellSide.push({ type: "EQL", group: "HTF", ...eql, ...(referenceCandles ? { activeFrom: candleCloseAt(referenceCandles, eql.formedIndex) ?? eql.formedTime } : {}) });

  if (referenceCandles) {
    annotateLiquidityStates(buySide, true, referenceCandles);
    annotateLiquidityStates(sellSide, false, referenceCandles);
  }

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
    const found = list.find((x) => x.type === t && (!x.state || x.state === "ACTIVE"));
    if (found) return found;
  }
  return list.find((x) => !x.state || x.state === "ACTIVE") || null;
}

/** 根据价位生效后的已收盘 K 标记流动性是否已消耗。 */
export function liquidityStateForLevel(level, isBuy, candles, activeFrom = level && (level.activeFrom ?? level.time)) {
  let sweptAt = null;
  let brokenAt = null;
  for (const k of candles || []) {
    if (activeFrom != null && (k.closeTime ?? k.time) <= activeFrom) continue;
    if (isBuy) {
      if (k.close > level.price) brokenAt = k.closeTime ?? k.time;
      else if (k.high > level.price && sweptAt == null) sweptAt = k.closeTime ?? k.time;
    } else {
      if (k.close < level.price) brokenAt = k.closeTime ?? k.time;
      else if (k.low < level.price && sweptAt == null) sweptAt = k.closeTime ?? k.time;
    }
  }
  if (brokenAt != null) return { state: "BROKEN", brokenAt, ...(sweptAt != null ? { sweptAt } : {}) };
  if (sweptAt != null) return { state: "SWEPT", sweptAt };
  return { state: "ACTIVE" };
}

function annotateLiquidityStates(levels, isBuy, candles) {
  for (const level of levels) Object.assign(level, liquidityStateForLevel(level, isBuy, candles));
}

function candleCloseAt(candles, index) {
  const k = index != null && candles ? candles[index] : null;
  return k ? k.closeTime ?? k.time : null;
}

/**
 * 等高点聚类（并查集/传递闭包）：两两价格在容差内视为同簇。
 * 返回 { price, touches, firstIndex, lastIndex, firstTime, lastTime }，或 null。
 * firstTime/lastTime 为触点 swing 所在 4H K 的开盘时间（swing 无 time 时省略，兼容旧输入）。
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
  const ordered = [...best].sort((a, b) => a.index - b.index);
  const first = ordered[0];
  const formed = ordered[1]; // 第二个触点出现后才真正形成 EQH/EQL
  const last = best.find((x) => x.index === indexes[indexes.length - 1]);
  const result = {
    price,
    touches: best.length,
    firstIndex: indexes[0],
    lastIndex: indexes[indexes.length - 1],
  };
  // 内部用于确定流动性位的生效时刻；保持旧公共返回 schema 不变。
  Object.defineProperty(result, "formedIndex", { value: formed.index, enumerable: false });
  if (first && first.time != null) result.firstTime = first.time;
  if (formed && formed.time != null) Object.defineProperty(result, "formedTime", { value: formed.time, enumerable: false });
  if (last && last.time != null) result.lastTime = last.time;
  return result;
}

export function findEqualHighs(swings, tolerance = EQ_TOLERANCE) {
  const items = swings.filter((s) => s.type === "HIGH").map((s) => ({ price: s.price, index: s.index, time: s.time }));
  return clusterByPrice(items, tolerance, "max");
}

export function findEqualLows(swings, tolerance = EQ_TOLERANCE) {
  const items = swings.filter((s) => s.type === "LOW").map((s) => ({ price: s.price, index: s.index, time: s.time }));
  return clusterByPrice(items, tolerance, "min");
}
