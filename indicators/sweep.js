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
 */

/**
 * @param {Array} h5m 5m K 线（{time,open,high,low,close,closeTime}）
 * @param {Array} buySide 上方流动性 [{type, price}]（如 PDH/PWH/EQH/外部高点）
 * @param {Array} sellSide 下方流动性 [{type, price}]（如 PDL/PWL/EQL/外部低点）
 * @param {number} [price] 当前最新价（实时检测的"收回"依据；缺省则只做已收盘检测）
 * @param {number} [window=48] 已收盘确认的回看窗口（根 5m，48 ≈ 4 小时）
 * @returns {Object|null}
 *   { side: "BSL"|"SSL", type, level, sweptPrice, close, time, key, realtime, closedTime? }
 *   time    — K 开盘时间（标识）
 *   key     — 事件去重键（`${openTime}_${side}`，同一根 5m 内同一侧只推一次）
 *   realtime— true=进行中 K 实时检测；false=已收盘 K 收盘确认
 *   closedTime — 已收盘事件确认时的 K 收盘时间（实时事件无此字段）
 */
export function detectSweeps(h5m, buySide, sellSide, price, window = 48) {
  const now = Date.now();
  const cur = h5m[h5m.length - 1];

  // 1) 实时：进行中的 K 已刺破流动性位，且当前最新价已收回（BSL：price 跌回 level 下；SSL：price 升回 level 上）
  if (cur && cur.closeTime > now && price != null) {
    for (const lv of buySide || []) {
      if (cur.high > lv.price && price < lv.price) {
        return { side: "BSL", type: lv.type, level: lv.price, sweptPrice: cur.high, close: price, time: cur.time, key: `${cur.time}_BSL`, realtime: true };
      }
    }
    for (const lv of sellSide || []) {
      if (cur.low < lv.price && price > lv.price) {
        return { side: "SSL", type: lv.type, level: lv.price, sweptPrice: cur.low, close: price, time: cur.time, key: `${cur.time}_SSL`, realtime: true };
      }
    }
  }

  // 2) 已收盘确认：最近 window 根内刺破后收回（从近到远，取最近一次）
  const closed = h5m.filter((k) => k.closeTime <= now);
  const recent = closed.slice(-window);
  for (let i = recent.length - 1; i >= 0; i--) {
    const k = recent[i];
    for (const lv of buySide || []) {
      if (k.high > lv.price && k.close < lv.price) {
        return { side: "BSL", type: lv.type, level: lv.price, sweptPrice: k.high, close: k.close, time: k.time, key: `${k.time}_BSL`, realtime: false, closedTime: k.closeTime };
      }
    }
    for (const lv of sellSide || []) {
      if (k.low < lv.price && k.close > lv.price) {
        return { side: "SSL", type: lv.type, level: lv.price, sweptPrice: k.low, close: k.close, time: k.time, key: `${k.time}_SSL`, realtime: false, closedTime: k.closeTime };
      }
    }
  }
  return null;
}
