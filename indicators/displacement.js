/**
 * displacement.js — 位移 K 检测（P1-C）
 *
 * ICT 2022：Displacement = 价格快速移动（大实体 K）离开某一区域，通常伴随 FVG。
 * 检测标准：实体（|close − open|）≥ 阈值倍（默认 1.5x）的前 N 根（默认 20）平均实体。
 * 输出方向（UP/DOWN）与倍数，供消息层标注"本根 4H 位移"。
 */

/**
 * @param {Array} h4 4H K 线（{time,open,high,low,close,closeTime}）
 * @param {Object} [opt]
 * @param {number} [opt.lookback=20] 平均实体回看窗口（根）
 * @param {number} [opt.threshold=1.5] 实体倍数阈值
 * @returns {Array<{time,direction,body,avgBody,ratio,close}>} 位移 K 列表（时间升序）
 */
export function findDisplacements(h4, { lookback = 20, threshold = 1.5 } = {}) {
  const closed = h4.filter((k) => k.closeTime <= Date.now());
  const out = [];
  for (let i = lookback; i < closed.length; i++) {
    let sum = 0;
    for (let j = i - lookback; j < i; j++) sum += Math.abs(closed[j].close - closed[j].open);
    const avgBody = sum / lookback;
    if (avgBody <= 0) continue;
    const body = Math.abs(closed[i].close - closed[i].open);
    const ratio = body / avgBody;
    if (ratio >= threshold) {
      out.push({
        time: closed[i].closeTime,
        direction: closed[i].close >= closed[i].open ? "UP" : "DOWN",
        body,
        avgBody,
        ratio,
        close: closed[i].close,
      });
    }
  }
  return out;
}
