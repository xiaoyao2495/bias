/**
 * 统一市场时钟。
 *
 * 服务器系统时间可能与 Binance 相差较大；K 线 closeTime、交易时段和事件时间均以
 * 交易所 epoch 为准。数据层同步 Binance serverTime 后更新 offset，其余模块只读取
 * marketNow()，避免各自用 Date.now() 造成收盘判断、调度和去重窗口互相不一致。
 */
let offsetMs = 0;
let lastSyncLocalMs = 0;

export function marketNow() {
  return Date.now() + offsetMs;
}

export function marketTimeFromLocal(localMs) {
  return Number(localMs) + offsetMs;
}

export function marketClockState() {
  return { offsetMs, lastSyncLocalMs };
}

/** 根据请求往返中点估算偏移；导出供数据层和纯函数测试使用。 */
export function updateMarketClock(serverTime, localBefore = Date.now(), localAfter = Date.now()) {
  const server = Number(serverTime);
  if (!Number.isFinite(server)) return false;
  const midpoint = (Number(localBefore) + Number(localAfter)) / 2;
  offsetMs = Math.round(server - midpoint);
  lastSyncLocalMs = Number(localAfter);
  return true;
}

export function marketClockNeedsSync(maxAgeMs, localNow = Date.now()) {
  return !lastSyncLocalMs || localNow - lastSyncLocalMs >= maxAgeMs;
}

/** 仅供测试复位；生产代码不应直接设置偏移。 */
export function resetMarketClockForTest() {
  offsetMs = 0;
  lastSyncLocalMs = 0;
}
