/**
 * sweep.js — 流动性扫损检测（Judas Swing 视角，P1-A）
 *
 * ICT 2022：价格常先刺破流动性位（PDH/PDL/PWH/PWL/EQH/EQL/外部结构高低点）
 * 后再反转——"扫掉止损"。本模块检测最近已收盘 4H 中的"刺破后收回"：
 *   上方流动性（BSL）被扫：K.high > level 但 K.close < level（刺破上方后收回）
 *   下方流动性（SSL）被扫：K.low  < level 但 K.close > level（刺破下方后收回）
 *
 * 只报告事件（市场刚刚发生了什么），不做方向预测——方向由 Bias/Scenario 层表达。
 */

/**
 * @param {Array} h4 4H K 线（{time,open,high,low,close,closeTime}）
 * @param {Array} buySide 上方流动性 [{type, price}]（如 PDH/PWH/EQH/外部高点）
 * @param {Array} sellSide 下方流动性 [{type, price}]（如 PDL/PWL/EQL/外部低点）
 * @param {number} [window=3] 检测最近 N 根已收盘 4H
 * @returns {Object|null}
 *   { side: "BSL"|"SSL", type, level, sweptPrice, close, time }
 *   或 null（最近 window 根内无扫损）
 */
export function detectSweeps(h4, buySide, sellSide, window = 3) {
  const closed = h4.filter((k) => k.closeTime <= Date.now());
  const recent = closed.slice(-window);

  // 从最近到最远，找到最近一次扫损事件
  for (let i = recent.length - 1; i >= 0; i--) {
    const k = recent[i];
    for (const lv of buySide || []) {
      if (k.high > lv.price && k.close < lv.price) {
        return { side: "BSL", type: lv.type, level: lv.price, sweptPrice: k.high, close: k.close, time: k.closeTime };
      }
    }
    for (const lv of sellSide || []) {
      if (k.low < lv.price && k.close > lv.price) {
        return { side: "SSL", type: lv.type, level: lv.price, sweptPrice: k.low, close: k.close, time: k.closeTime };
      }
    }
  }
  return null;
}
