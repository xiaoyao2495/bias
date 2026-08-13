/**
 * displacement.js — 位移 K 检测（ICT 2022 三条件）
 *
 * ICT 2022 定义：Displacement 是价格快速离开某区域的行为，必须同时满足三条件：
 *   1. BODY（动量）     : 实体 |close−open| ≥ 阈值倍 × 前 lookback 根平均实体（大实体 K）
 *   2. STRUCTURE BREAK : 收盘越过最近 Swing High（UP）/ Swing Low（DOWN）→ BOS
 *   3. FVG（缺口）      : 位移 K 相邻形成同向 Fair Value Gap（UP → bullish FVG，DOWN → bearish FVG）
 *
 * 三条缺一不可：仅大实体（如趋势加速段）不算 displacement；必须伴随结构突破与 FVG，
 * 才是机构推动离场的特征。输出每条带 structureBreak 与 fvg 证据字段（供审计/展示）。
 *
 * 输入用 5m K 线：位移是分钟级价格行为，5m 粒度能捕捉"刚刚"的强动量 K；
 * swing 参照用 ICT 最小窗口（每侧 1 根），与 5m MSS/BOS 检测（mss.js）一致。
 */

/**
 * @param {Array} h5m 5m K 线（{time,open,high,low,close,closeTime}）
 * @param {Object} [opt]
 * @param {number} [opt.lookback=20] 平均实体回看窗口（根）
 * @param {number} [opt.threshold=1.5] 实体倍数阈值
 * @returns {Array<{time,direction,body,avgBody,ratio,close,structureBreak,fvg}>}
 *   位移 K 列表（时间升序，time=K 收盘时间）。
 *   structureBreak: { type:"BOS", direction, level, swingIndex } 被突破的最近 swing
 *   fvg: { top, bottom, middleIndex } 相邻同向缺口（middleIndex = 缺口中间根）
 */
export function findDisplacements(h5m, { lookback = 20, threshold = 1.5 } = {}) {
  const closed = h5m.filter((k) => k.closeTime <= Date.now());
  if (closed.length <= lookback) return [];

  // 逐 index 记录"该 K 之前最近已确认的 Swing High/Low"（结构 break 参照）。
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
    let sum = 0;
    for (let j = i - lookback; j < i; j++) sum += Math.abs(closed[j].close - closed[j].open);
    const avgBody = sum / lookback;
    if (avgBody <= 0) continue;
    const ratio = body / avgBody;
    if (ratio < threshold) continue;

    const dir = c.close >= c.open ? "UP" : "DOWN";
    // 条件 2：结构突破 —— 收盘越过最近 swing（BOS，与 MSS 检测同用 close beyond 语义）
    const swingRef = dir === "UP" ? lastHighAt[i] : lastLowAt[i];
    const broke = swingRef && (dir === "UP" ? c.close > swingRef.price : c.close < swingRef.price);
    if (!broke) continue;
    // 条件 3：FVG —— 位移 K 相邻（第三根或中间根）形成同向缺口（与 pdArray.findFvgs 定义一致）
    const fvg = dir === "UP" ? bullishFvg(closed, i) : bearishFvg(closed, i);
    if (!fvg) continue;

    out.push({
      time: c.closeTime,
      direction: dir,
      body,
      avgBody,
      ratio,
      // 位移质量（审计/展示）：满足三条件才有此条目，因此最低为 MEDIUM；
      // ratio ≥ 2× 平均实体为强位移（与 4H 收盘报告的 strongOppositeDisp 同语义）
      quality: ratio >= 2 ? "HIGH" : "MEDIUM",
      close: c.close,
      index: i, // 在 closed（已收盘）数组中的索引——供 mss.js 与结构事件对齐打标
      // FVG 真正确认的 K 索引（P1 防前视）：
      //   位移 K 为第三根 → FVG 由位移 K 自身确认 → confirmationIndex = i
      //   位移 K 为中间根 → FVG 由下一根（i+1）确认 → confirmationIndex = i + 1
      // 消费方（mss.js）必须确认 confirmationIndex 已到（<= 当前已收盘索引）才能使用，
      // 否则逐根历史扫描会提前一根读到"未来的确认 K"。
      confirmationIndex: fvg.middleIndex + 1,
      structureBreak: { type: "BOS", direction: dir, level: swingRef.price, swingIndex: swingRef.index },
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
