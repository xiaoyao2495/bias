/**
 * evaluator.js — V2.2 未来表现评估 + V2.4 盈亏质量
 *
 * 对一个 Bias 样本，判断未来 N 根 4H K 线内的结果：
 *   WIN     : 先触及目标（Draw Target 或 +targetPct 幅度，取更近者）
 *   LOSS    : 先触及 Invalidation（保护位）
 *   NEUTRAL : 窗口内两者都未触及
 *   SKIP    : 无方向 / 无保护位 / 无未来数据（不参与统计）
 *
 * 逐根 K 线按时间顺序判定，先到先判（避免"既到目标又破位"的歧义）。
 * 同时记录每个窗口的高/低/收盘、最大 R（最佳浮盈 / 风险）。
 *
 * V2.4 新增三个质量维度（方向正确性 ≠ 盈亏质量）：
 *   planR   : 理论盈亏比 = |Draw − Entry| / Risk（回答"值不值得交易"）
 *   r       : 每窗口结果盈亏比（WIN→实际触及幅度/风险，LOSS→−1，NEUTRAL→收盘相对风险）
 *   MAE/MFE: 整个窗口最大逆行/顺行百分比（路径质量）
 * 只做评估，不参与 Bias 判定。
 */

const DEFAULT_WINDOWS = [7, 14, 30]; // 未来 4H K 线根数 ≈ 1.25 / 2.5 / 5 天

/**
 * @param {object} p
 * @param {"BULLISH"|"BEARISH"|"NEUTRAL"} p.bias   样本 Bias
 * @param {number} p.entry                         样本价（当前 4H 收盘）
 * @param {number|null} p.invalidation             保护位价格（null → SKIP）
 * @param {number|null} p.drawPrice                Draw Target 价格（null → 只用 targetPct）
 * @param {number} p.targetPct                     目标幅度（默认 0.05 = +5%/-5%）
 * @param {Array} p.futureCandles                  样本之后的 4H K 线（按时间正序）
 * @param {number[]} [p.windows]                   评估窗口（未来 K 线根数）
 * @returns {{ futures: Object, maxR: number|null, planR: number|null, maePct: number|null, mfePct: number|null }}
 *   futures[window] = { high, low, close, outcome, hitDraw, hitInvalidation, r }
 */
export function evaluateOutcome({ bias, entry, invalidation, drawPrice = null, targetPct = 0.05, futureCandles, windows = DEFAULT_WINDOWS }) {
  const maxW = Math.max(...windows);
  const fut = (futureCandles || []).slice(0, maxW);

  const risk = invalidation != null && entry != null ? (bias === "BULLISH" ? entry - invalidation : invalidation - entry) : null;
  const riskPct = risk != null && entry != null && entry > 0 ? risk / entry : null;

  // V2.4：理论盈亏比（计划 R）——回答"这个 Bias 值不值得交易"
  let planR = null;
  if (risk != null && risk > 0 && drawPrice != null && entry != null) {
    planR = Math.abs(drawPrice - entry) / risk;
  }

  const futures = {};
  for (const w of windows) {
    const slice = fut.slice(0, w);
    futures[w] = evaluateWindow({ bias, entry, invalidation, drawPrice, targetPct, candles: slice, risk, riskPct, planR });
  }

  // 最大 R：整个 maxW 窗口内最佳浮盈 / 风险（bull: (maxHigh - entry)/risk；bear: (entry - minLow)/risk）
  let maxR = null;
  if (risk != null && risk > 0 && fut.length) {
    if (bias === "BULLISH") {
      const best = Math.max(...fut.map((k) => k.high));
      maxR = (best - entry) / risk;
    } else if (bias === "BEARISH") {
      const best = Math.min(...fut.map((k) => k.low));
      maxR = (entry - best) / risk;
    }
  }

  // V2.4：MAE/MFE（相对 entry 的百分比，整个 maxW 窗口，不早停）
  let maePct = null;
  let mfePct = null;
  if (entry != null && entry > 0 && fut.length) {
    const maxHigh = Math.max(...fut.map((k) => k.high));
    const minLow = Math.min(...fut.map((k) => k.low));
    if (bias === "BULLISH") {
      mfePct = (maxHigh - entry) / entry;
      maePct = (entry - minLow) / entry;
    } else if (bias === "BEARISH") {
      mfePct = (entry - minLow) / entry;
      maePct = (maxHigh - entry) / entry;
    }
  }

  return { futures, maxR, planR, maePct, mfePct };
}

function evaluateWindow({ bias, entry, invalidation, drawPrice, targetPct, candles, risk, riskPct, planR }) {
  if (bias === "NEUTRAL" || entry == null || invalidation == null || !candles.length) {
    return {
      high: windowHigh(candles),
      low: windowLow(candles),
      close: candles.length ? candles[candles.length - 1].close : null,
      outcome: "SKIP",
      hitDraw: false,
      hitInvalidation: false,
      r: null,
    };
  }

  const bull = bias === "BULLISH";
  // 目标线 = Draw Target 与 targetPct 幅度中更近者（先到先判）
  const target = bull
    ? drawPrice != null
      ? Math.min(drawPrice, entry * (1 + targetPct))
      : entry * (1 + targetPct)
    : drawPrice != null
      ? Math.max(drawPrice, entry * (1 - targetPct))
      : entry * (1 - targetPct);

  let outcome = "NEUTRAL";
  let hitDraw = false;
  let hitInvalidation = false;

  for (const k of candles) {
    if (bull) {
      if (k.high >= target) {
        outcome = "WIN";
        if (drawPrice != null && k.high >= drawPrice) hitDraw = true;
        break;
      }
      if (k.low <= invalidation) {
        outcome = "LOSS";
        hitInvalidation = true;
        break;
      }
    } else {
      if (k.low <= target) {
        outcome = "WIN";
        if (drawPrice != null && k.low <= drawPrice) hitDraw = true;
        break;
      }
      if (k.high >= invalidation) {
        outcome = "LOSS";
        hitInvalidation = true;
        break;
      }
    }
  }

  // V2.4：结果盈亏比 r（只对有风险、有结论/收盘的窗口计算）
  let r = null;
  if (risk != null && risk > 0) {
    if (outcome === "WIN") {
      if (hitDraw && planR != null) r = planR; // 真正触及 Draw → 理论盈亏比即结果盈亏比
      else if (riskPct != null && riskPct > 0) r = targetPct / riskPct; // 只到 ±targetPct 幅度线
    } else if (outcome === "LOSS") {
      r = -1; // 触及保护位 = 全损
    } else {
      const close = candles[candles.length - 1].close; // NEUTRAL：最终收盘相对风险
      r = (bull ? close - entry : entry - close) / risk;
    }
  }

  return {
    high: windowHigh(candles),
    low: windowLow(candles),
    close: candles[candles.length - 1].close,
    outcome,
    hitDraw,
    hitInvalidation,
    r,
  };
}

function windowHigh(candles) {
  if (!candles.length) return null;
  return Math.max(...candles.map((k) => k.high));
}

function windowLow(candles) {
  if (!candles.length) return null;
  return Math.min(...candles.map((k) => k.low));
}
