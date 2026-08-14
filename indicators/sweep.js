/**
 * sweep.js — 流动性扫损检测（Judas Swing 视角，P1-A）
 *
 * ICT 2022：价格常先刺破流动性位（PDH/PDL/PWH/PWL/EQH/EQL/外部结构高低点）
 * 后再反转——"扫掉止损"。本模块检测"刺破后收回"：
 *   上方流动性（BSL）被扫：刺破 level 后价格收回 level 下方
 *   下方流动性（SSL）被扫：跌破 level 后价格收回 level 上方
 *
 * 两级检测（降低延迟）：
 *   1. 实时：进行中的 5m K 已刺破流动性位，且当前最新价已收回（轮询级延迟 ≤10 分钟）
 *   2. 已确认：最近已收盘 5m K 中"刺破后收回"（5m 收盘确认，延迟 ≤5 分钟）
 *
 * 输入用 5m K 线：扫损是分钟级价格行为（刺破流动性位后快速收回），
 * 4H 单根 K 会把"刺破+收回"整个包住，粒度过粗；5m 可精确到具体哪根 K。
 *
 * 只报告事件（市场刚刚发生了什么），不做方向预测——方向由 Bias/Scenario 层表达。
 *
 * Judas Swing（ICT 2022）：NY Open 窗口内的扫损 + 方向与 4H Bias 相反 → 开盘假动作。
 *   先插针扫掉流动性（止损），随后反转走真方向（多头 Bias 扫 SSL / 空头 Bias 扫 BSL）。
 *   sweep 结果带 judas: true 标记，供消息层提示"留意反转"。
 */

/**
 * Judas Swing 窗口：美股开盘后 90 分钟（用北京时间）。
 *   夏令时（4-10 月）：21:30-23:00；冬令时（11-3 月）：22:30-24:00。
 *   用月份近似 DST 边界（误差仅在 DST 切换周）。
 * @param {Date} [now] 测试可注入
 */
export function isJudasWindow(now = new Date()) {
  const bj = new Date(now.getTime() + 8 * 3600_000);
  const h = bj.getUTCHours() + bj.getUTCMinutes() / 60;
  const dst = bj.getUTCMonth() >= 3 && bj.getUTCMonth() <= 9; // 4-10 月为夏令时
  const start = dst ? 21.5 : 22.5;
  const end = dst ? 23 : 24;
  return h >= start && h < end;
}

/** Judas 判定：扫损方向与 bias 相反（BULLISH 扫 SSL / BEARISH 扫 BSL）才算开盘假动作 */
function judasOf(side, bias) {
  if (bias === "BULLISH") return side === "SSL";
  if (bias === "BEARISH") return side === "BSL";
  return false;
}

/**
 * @param {Array} h5m 5m K 线（{time,open,high,low,close,closeTime}）
 * @param {Array} buySide 上方流动性 [{type, price, time?, date?}]（如 PDH/PWH/EQH/外部高点）
 * @param {Array} sellSide 下方流动性 [{type, price, time?, date?}]（如 PDL/PWL/EQL/外部低点）
 * @param {number} [price] 当前最新价（实时检测的"收回"依据；缺省则只做已收盘检测）
 * @param {number} [window=48] 已收盘确认的回看窗口（根 5m，48 ≈ 4 小时）
 * @param {"BULLISH"|"BEARISH"|null} [bias] 4H 有效 Bias（用于 Judas Swing 判定；缺省则不做方向判断）
 * @returns {Object|null}
 *   { side: "BSL"|"SSL", type, level, sweptPrice, close, time, key, realtime, closedTime?, judas?, levelTime?, levelDate? }
 *   time    — K 开盘时间（标识）
 *   key     — 事件去重键（`${openTime}_${side}`，同一根 5m 内同一侧只推一次）
 *   realtime— true=进行中 K 实时检测；false=已收盘 K 收盘确认
 *   closedTime — 已收盘事件确认时的 K 收盘时间（实时事件无此字段）
 *   judas   — true=NY Open 窗口内且方向与 bias 相反的扫损（开盘假动作）
 *   levelTime/levelDate — 被扫流动性位的形成时间（透传自流动性项：levelTime=形成 K 开盘 ms，
 *     如 PDH 的昨日日 K；levelDate=盘前区间北京日期 "YYYY-MM-DD"），供消息层展示"这个流动性是什么时候形成的"
 */
export function detectSweeps(h5m, buySide, sellSide, price, window = 48, bias = null) {
  const now = Date.now();
  const cur = h5m[h5m.length - 1];

  /** 透传流动性位的形成时间（lv 无 time/date 时省略，不产生 undefined 字段） */
  const levelMeta = (lv) => {
    const m = {};
    if (lv.time != null) m.levelTime = lv.time;
    if (lv.date != null) m.levelDate = lv.date;
    return m;
  };

  // 流动性位是否早已被消费（位形成之后任一根已收盘 K 收在 level 外侧）：
  //   BSL 只要收在 level 上方 → 该位已破位/被扫，之后插针只是回测旧位，不算新扫损；SSL 对称。
  // 只认位形成之后的收盘（wick 刺破不算消费，与扫损"收回"语义一致）。
  // 位形成之前的历史 K 收在 level 外侧不是对本位的消费——否则"低于历史高点"的内部摆动位/PDH
  // 会被永久判为已消费，扫损永不报（08/15 扫损骤减根因：42 个 ACTIVE 位被吞、DOGE/NBIS 漏报）。
  const alreadyTaken = (lv, isBuy, upToIndex) => {
    const from = lv.time != null ? lv.time : 0; // 位形成 K 的开盘时间；无 time（如 EQH）退化为全历史
    for (let i = 0; i < upToIndex; i++) {
      const k = h5m[i];
      if (k.closeTime > now) continue;
      if (k.time < from) continue; // 位形成前的 K 不构成对本位的消费
      if (isBuy ? k.close > lv.price : k.close < lv.price) return true;
    }
    return false;
  };

  // 1) 实时：进行中的 K 已刺破流动性位，且当前最新价已收回（BSL：price 跌回 level 下；SSL：price 升回 level 上）
  if (cur && cur.closeTime > now && price != null) {
    const lastIdx = h5m.length - 1;
    for (const lv of buySide || []) {
      if (cur.high > lv.price && price < lv.price && !alreadyTaken(lv, true, lastIdx)) {
        return { side: "BSL", type: lv.type, level: lv.price, sweptPrice: cur.high, close: price, time: cur.time, key: `${cur.time}_BSL`, realtime: true, judas: judasOf("BSL", bias) && isJudasWindow(new Date(cur.time)), ...levelMeta(lv) };
      }
    }
    for (const lv of sellSide || []) {
      if (cur.low < lv.price && price > lv.price && !alreadyTaken(lv, false, lastIdx)) {
        return { side: "SSL", type: lv.type, level: lv.price, sweptPrice: cur.low, close: price, time: cur.time, key: `${cur.time}_SSL`, realtime: true, judas: judasOf("SSL", bias) && isJudasWindow(new Date(cur.time)), ...levelMeta(lv) };
      }
    }
  }

  // 2) 已收盘确认：最近 window 根内刺破后收回（从近到远，取最近一次）
  const closed = h5m.filter((k) => k.closeTime <= now);
  const recent = closed.slice(-window);
  for (let i = recent.length - 1; i >= 0; i--) {
    const k = recent[i];
    const idx = h5m.indexOf(k);
    for (const lv of buySide || []) {
      // 单根内完成：本根刺破且收盘收回下方
      if (k.high > lv.price && k.close < lv.price && !alreadyTaken(lv, true, idx)) {
        return { side: "BSL", type: lv.type, level: lv.price, sweptPrice: k.high, close: k.close, time: k.time, key: `${k.time}_BSL`, realtime: false, closedTime: k.closeTime, judas: judasOf("BSL", bias) && isJudasWindow(new Date(k.time)), ...levelMeta(lv) };
      }
      // V2.7 跨根收回：本根刺破但收盘未收回（仍在上方），次根（已收盘）收回下方也算 BSL。
      // ICT 中"插针式扫损"常在 1-2 根内完成；跨根形态比突破回踩更接近扫损语义。
      const next = h5m[idx + 1];
      if (k.high > lv.price && k.close >= lv.price && next && next.closeTime <= now && next.close < lv.price && !alreadyTaken(lv, true, idx)) {
        return { side: "BSL", type: lv.type, level: lv.price, sweptPrice: k.high, close: next.close, time: k.time, key: `${k.time}_BSL`, realtime: false, closedTime: next.closeTime, judas: judasOf("BSL", bias) && isJudasWindow(new Date(k.time)), ...levelMeta(lv) };
      }
    }
    for (const lv of sellSide || []) {
      // 单根内完成：本根刺破且收盘收回上方
      if (k.low < lv.price && k.close > lv.price && !alreadyTaken(lv, false, idx)) {
        return { side: "SSL", type: lv.type, level: lv.price, sweptPrice: k.low, close: k.close, time: k.time, key: `${k.time}_SSL`, realtime: false, closedTime: k.closeTime, judas: judasOf("SSL", bias) && isJudasWindow(new Date(k.time)), ...levelMeta(lv) };
      }
      // V2.7 跨根收回：本根刺破但收盘未收回（仍在下方），次根（已收盘）收回上方也算 SSL。
      const next = h5m[idx + 1];
      if (k.low < lv.price && k.close <= lv.price && next && next.closeTime <= now && next.close > lv.price && !alreadyTaken(lv, false, idx)) {
        return { side: "SSL", type: lv.type, level: lv.price, sweptPrice: k.low, close: next.close, time: k.time, key: `${k.time}_SSL`, realtime: false, closedTime: next.closeTime, judas: judasOf("SSL", bias) && isJudasWindow(new Date(k.time)), ...levelMeta(lv) };
      }
    }
  }
  return null;
}
