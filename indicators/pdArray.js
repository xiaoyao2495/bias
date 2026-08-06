/**
 * pdArray.js — PD Array：FVG 与 Order Block
 *
 * FVG（三根 K）：定义正确，保持。
 *   Bullish FVG : K1.high < K3.low  → 向上缺口，top = K3.low, bottom = K1.high
 *   Bearish FVG : K1.low  > K3.high → 向下缺口，top = K1.low,  bottom = K3.high
 *
 * Order Block（EXPERIMENTAL）：简单版（阴线后强阳突破 / 阳线后强阴跌破），仅用于展示。
 *   ICT 中 OB 应关注导致 Displacement / MSS / BOS 的根 K。V1.6 增加 confirmed 标记，不参与 Bias。
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
export function findOrderBlocks(candles) {
  const obs = [];
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

    obs.push({
      type: bullish ? "BULLISH_OB" : "BEARISH_OB",
      direction: bullish ? "BULLISH" : "BEARISH",
      high,
      low,
      index: i,
      time: prev.time,
      experimental: true,
      confirmed: true,
      kind,
      state: used ? "USED" : "FRESH",
    });
  }
  return obs;
}

/**
 * V1.6：给 FVG/OB 标注执行属性。
 *   location：区间中点相对 dealing range 中线 → PREMIUM / DISCOUNT / AT_EQ
 *   age     ：距当前 K 的根数（越小越新）
 *   status  ：OPEN / FILLED（Bullish FVG 被后续 K 的 low 刺入 → FILLED；Bearish 反之；OB 价格回到区间 → FILLED）
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
      for (let i = item.index + 1; i <= currentIndex; i++) {
        if (candles[i].low <= item.top) { status = "FILLED"; break; }
      }
    } else if (item.type === "BEARISH_FVG") {
      for (let i = item.index + 1; i <= currentIndex; i++) {
        if (candles[i].high >= item.bottom) { status = "FILLED"; break; }
      }
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

    const top = item.top ?? item.high; // OB 项用 high/low
    const bottom = item.bottom ?? item.low;
    const mid = (top + bottom) / 2;
    const loc = eq == null ? null : mid > eq ? "PREMIUM" : mid < eq ? "DISCOUNT" : "AT_EQ";
    const inFavor = isBuyBias ? loc === "DISCOUNT" : loc === "PREMIUM";

    let score = 60 + (inFavor ? 30 : -20);
    if (item.status === "FILLED") score -= 25;
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
