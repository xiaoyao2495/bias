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

/** 找出所有 Order Block（EXPERIMENTAL，简单版；突破发生时已确认） */
export function findOrderBlocks(candles) {
  const obs = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const cur = candles[i];

    const prevBearish = prev.close < prev.open;
    const prevBullish = prev.close > prev.open;
    const curBullish = cur.close > cur.open;
    const curBearish = cur.close < cur.open;

    if (prevBearish && curBullish && cur.close > prev.high) {
      obs.push({ type: "BULLISH_OB", direction: "BULLISH", high: prev.high, low: prev.low, index: i, time: prev.time, experimental: true, confirmed: true });
    }
    if (prevBullish && curBearish && cur.close < prev.low) {
      obs.push({ type: "BEARISH_OB", direction: "BEARISH", high: prev.high, low: prev.low, index: i, time: prev.time, experimental: true, confirmed: true });
    }
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
