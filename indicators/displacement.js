import { marketNow } from "../utils/marketClock.js";

/**
 * displacement.js — 位移 K 检测（ICT 2022：价格快速、单边地离开区间）
 *
 * 课程不把中心化交易所成交量定义成 displacement 的硬门槛（外汇等市场也没有统一成交量）。
 * 工程判定使用可观察的价格交付：大实体、实体占整根比例高、收盘靠近推动方向极值。
 * 成交量只作为 confluence 输出；调用方确有需要时可用 requireVolume 显式开启门槛。
 *
 * FVG 与结构突破不是位移定义的必要条件，作为标签输出（可能为 null）：
 *   - structureBreak : 位移收盘越过的最近 Swing（BOS）。位移是验证 MSS/BOS 的动能，
 *                      区间内强动量（未破结构）同样是位移 → 标签可空
 *   - fvg            : 位移留下的同向缺口（ICT 用 FVG 识别位移的"脚印"）→ 标签可空
 *
 * 输入用 5m K 线：位移是分钟级价格行为，5m 粒度能捕捉"刚刚"的强动量 K；
 * swing 参照用 ICT 最小窗口（每侧 1 根），与 5m MSS/BOS 检测（mss.js）一致。
 * 成交量：优先 quoteVol（USDT 成交额，最能代表资金）；真实行情有量时输出 volumeRatio
 * 供共振评分/审计，但默认仍以价格交付确认 displacement。
 */

/**
 * @param {Array} h5m 5m K 线（{time,open,high,low,close,closeTime,quoteVol?}）
 * @param {Object} [opt]
 * @param {number} [opt.lookback=20] 平均实体回看窗口（根）
 * @param {number} [opt.threshold=1.5] 实体倍数阈值
 * @param {number} [opt.volumeLookback=20] 均量回看窗口（根）
 * @param {number} [opt.volumeThreshold=1.5] 量能倍数阈值
 * @returns {Array<{time,direction,body,avgBody,ratio,volumeRatio,close,structureBreak,fvg}>}
 *   位移 K 列表（时间升序，time=K 收盘时间）。
 *   structureBreak: { type:"BOS", direction, level, swingIndex } | null（结构突破标签）
 *   fvg: { top, bottom, middleIndex } | null（缺口标签）
 *   volumeRatio: 位移 K 量 / 前 volumeLookback 根均量（无成交量数据时为 null）
 */
export function findDisplacements(h5m, {
  lookback = 20,
  threshold = 1.5,
  minBodyFraction = 0.6,
  minCloseLocation = 0.75,
  volumeLookback = 20,
  volumeThreshold = 1.5,
  requireVolume = false,
} = {}) {
  const closed = h5m.filter((k) => k.closeTime <= marketNow());
  if (closed.length <= lookback) return [];

  // 成交量数据是否存在（真实 kline 恒有 quoteVol；测试 fixture 无量 → 跳过量门槛）
  const volOf = (k) => (k && (k.quoteVol ?? k.volume)) || 0;
  const hasVolData = closed.some((k) => volOf(k) > 0);

  // 逐 index 记录"该 K 之前最近已确认的 Swing High/Low"（结构 break 标签参照）。
  // 不用 findSwings()：其 dedupeAlternating 会把"位移 K 自身"（更极端的同类型 swing）
  // 合并成最近 swing，导致 break 参照被位移 K 自己顶掉、结构突破永远检测不到
  // （位移 K 本身就是新极值）。这里按 1/1 窗口逐根确认：i 到达时确认 i-1 是否为 swing
  // （右侧邻居 = 当前 K），参照恒为"位移 K 之前已确认"的 swing，位移 K 自身不参与。
  const lastHighAt = new Array(closed.length).fill(null);
  const lastLowAt = new Array(closed.length).fill(null);
  let lastHigh = null;
  let lastLow = null;
  for (let i = 0; i < closed.length; i++) {
    if (i >= 2) {
      const j = i - 1; // 当前 K i 确认 swing j（j+1 = i）
      const a = closed[j - 1];
      const b = closed[j];
      const c = closed[i];
      if (b.high > a.high && b.high > c.high) lastHigh = { type: "HIGH", price: b.high, index: j };
      if (b.low < a.low && b.low < c.low) lastLow = { type: "LOW", price: b.low, index: j };
    }
    lastHighAt[i] = lastHigh;
    lastLowAt[i] = lastLow;
  }

  const out = [];
  for (let i = lookback; i < closed.length; i++) {
    const c = closed[i];
    const body = Math.abs(c.close - c.open);
    if (body <= 0) continue;
    // 使用包含 OHLC 的真实包络，既防御脏数据，也避免测试/交易所异常字段造成负比例。
    const effectiveHigh = Math.max(c.high, c.open, c.close);
    const effectiveLow = Math.min(c.low, c.open, c.close);
    const fullRange = effectiveHigh - effectiveLow;
    if (!(fullRange > 0)) continue;
    const bodyFraction = body / fullRange;
    if (bodyFraction < minBodyFraction) continue;
    let sum = 0;
    for (let j = i - lookback; j < i; j++) sum += Math.abs(closed[j].close - closed[j].open);
    const avgBody = sum / lookback;
    if (avgBody <= 0) continue;
    const ratio = body / avgBody;
    if (ratio < threshold) continue;

    const dir = c.close >= c.open ? "UP" : "DOWN";
    const closeLocation = dir === "UP" ? (c.close - effectiveLow) / fullRange : (effectiveHigh - c.close) / fullRange;
    if (closeLocation < minCloseLocation) continue;

    // 成交量仅作辅助证据；默认不因单一交易所量能不足否决价格位移。
    let volumeRatio = null;
    if (hasVolData) {
      const vFrom = Math.max(0, i - volumeLookback);
      let vsum = 0;
      for (let j = vFrom; j < i; j++) vsum += volOf(closed[j]);
      const avgVol = vsum / (i - vFrom);
      if (avgVol > 0) {
        const vr = volOf(c) / avgVol;
        if (requireVolume && vr < volumeThreshold) continue;
        volumeRatio = vr;
      }
    }

    // 标签 1：结构突破（BOS）—— 收盘越过最近 swing；区间内强动量可能没有 → null
    const swingRef = dir === "UP" ? lastHighAt[i] : lastLowAt[i];
    const structureBreak = swingRef && (dir === "UP" ? c.close > swingRef.price : c.close < swingRef.price)
      ? { type: "BOS", direction: dir, level: swingRef.price, swingIndex: swingRef.index }
      : null;
    // 标签 2：FVG（位移的"脚印"）—— 位移 K 相邻（第三根或中间根）形成同向缺口；
    // 与 pdArray.findFvgs 定义一致；没有 → null
    const fvg = dir === "UP" ? bullishFvg(closed, i) : bearishFvg(closed, i);

    out.push({
      time: c.closeTime,
      direction: dir,
      body,
      avgBody,
      ratio,
      bodyFraction,
      closeLocation,
      volumeRatio,
      // 位移质量（审计/展示）：ratio ≥ 2× 平均实体为强位移（与 4H 收盘报告的 strongOppositeDisp 同语义）
      quality: ratio >= 2 && bodyFraction >= 0.7 && closeLocation >= 0.8 ? "HIGH" : "MEDIUM",
      close: c.close,
      index: i, // 在 closed（已收盘）数组中的索引——供 mss.js 与结构事件对齐打标
      // 关联 FVG 真正确认的 K 索引（P1 防前视；位移本身仍在 i 收盘确认）：
      //   位移 K 为第三根 → FVG 由位移 K 自身确认 → confirmationIndex = i
      //   位移 K 为中间根 → FVG 由下一根（i+1）确认 → confirmationIndex = i + 1
      //   无 FVG → 没有额外等待，confirmationIndex = i
      // 消费方可立即使用 displacement；只有消费 d.fvg 时必须确认该索引已经到达。
      confirmationIndex: fvg ? fvg.middleIndex + 1 : i,
      structureBreak,
      fvg,
    });
  }
  return out;
}

/** UP 位移关联的 bullish FVG（位移 K 可为第三根或中间根；与 pdArray.findFvgs 定义一致） */
function bullishFvg(closed, i) {
  if (i >= 2 && closed[i].low > closed[i - 2].high) {
    return { top: closed[i].low, bottom: closed[i - 2].high, middleIndex: i - 1 };
  }
  if (i + 1 < closed.length && closed[i + 1].low > closed[i - 1].high) {
    return { top: closed[i + 1].low, bottom: closed[i - 1].high, middleIndex: i };
  }
  return null;
}

/** DOWN 位移关联的 bearish FVG（位移 K 为第三根或中间根） */
function bearishFvg(closed, i) {
  if (i >= 2 && closed[i].high < closed[i - 2].low) {
    return { top: closed[i - 2].low, bottom: closed[i].high, middleIndex: i - 1 };
  }
  if (i + 1 < closed.length && closed[i + 1].high < closed[i - 1].low) {
    return { top: closed[i - 1].low, bottom: closed[i + 1].high, middleIndex: i };
  }
  return null;
}
