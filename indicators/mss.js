/**
 * mss.js — MSS / BOS 检测（P1-B）
 *
 * ICT 2022 结构观：结构变化不取决于"看到 HH/HL 组合"，而取决于"哪个 swing 被打破"。
 *
 *   BOS（Break of Structure，顺势突破 → 趋势延续）：
 *     BULLISH : close > 最近 Swing High（lastHigh）→ BOS_UP
 *     BEARISH : close < 最近 Swing Low（lastLow） → BOS_DOWN
 *   MSS（Market Structure Shift，反势打破 → 趋势转移的第一迹象）：
 *     BULLISH : close < 最近 Swing Low（lastLow） → MSS_DOWN
 *     BEARISH : close > 最近 Swing High（lastHigh）→ MSS_UP
 *
 * 触发基准用"最近 swing"（lastHigh / lastLow），与 V1.4 的 protectedLow/High 职责分开：
 *   protectedLow/High（最后一个 HH/LL 前的结构启动位）仅保留在 structureLayer 中供 4H
 *   失效位审计，不再作为 MSS 触发基准——否则最新 HL/LH 在最后一个 HH/LL 之后时，
 *   MSS 会被推迟到更深的位（ICT 中 MSS = 打破最近反方向 swing）。
 *
 * 收盘确认（ICT：close beyond 才算结构转移）：
 *   - swing 判定只用已收盘 K（进行中 K 不参与 Pivot 右侧确认——其 high/low 实时变动
 *     会使已确认 swing 点漂移）；未收盘 K 仅经 price 提供"实时触发"
 *   - 末根 K 已收盘 → 用其 close 判定，事件 confirmed=true
 *   - 末根 K 进行中 → 用实时 price 判定，事件 confirmed=false、realtime=true（仅提示；
 *     wick 插针刺破后收回属于 Sweep 模块的流动性事件，不算结构转移）
 *
 * Swing 窗口按周期（ICT：5m 用最小定义每侧 1 根，4H 保持每侧 2 根）：
 *   detectStructureEvents(candles, { left: 1, right: 1 })  // 5m 入场层
 *   detectStructureEvents(candles)                          // 4H 环境层（默认 2/2）
 */

import { findSwings, analyzeSwings } from "./swing.js";
import { buildStructure } from "./structure.js";

function mkEvent(type, direction, level, price, swingIndex, reason, confirmed, realtime) {
  // 事件基准均为最近 swing（lastHigh/lastLow）→ INTERNAL；external 位只存在于 structureLayer 审计
  return { type, direction, level, levelType: "INTERNAL", price, swingIndex, reason, confirmed, realtime };
}

/**
 * 检测"当前时刻"的 MSS / BOS 事件。
 *
 * @param {Array} candles K 线（时间升序；{time,open,high,low,close,closeTime}）
 * @param {Object} [opt]
 * @param {number} [opt.price] 实时触发价（末根未收盘时用；缺省取末根 close）
 * @param {number} [opt.left=2]  swing 左侧确认 K 数（5m 用 1）
 * @param {number} [opt.right=2] swing 右侧确认 K 数（5m 用 1）
 * @returns {{
 *   direction: "BULLISH"|"BEARISH"|"NEUTRAL",  // swing 判定的当前结构方向
 *   structureStatus: "VALID"|"INVALIDATED",     // 最近 swing 是否被反势打破（= 是否已触发 MSS）
 *   structureLayer: { internal, external },     // Internal / External 分层
 *   events: Array,                              // 当前触发的 MSS/BOS 事件
 *   lastEvent: Object|null                      // 最近一次事件（消息层直接渲染）
 * }}
 */
export function detectStructureEvents(candles, { price, left = 2, right = 2 } = {}) {
  const now = Date.now();
  // 修复（等待 K 收盘）：swing 判定只用已收盘 K。
  // 进行中 K 的 high/low/close 会随实时成交变动，若参与 Pivot 右侧确认，
  // 会使倒数第 2 根的 swing 状态随实时价漂移（同一根 K 时而确认时而否决），
  // 进而污染 lastHigh/lastLow 与 MSS/BOS 判定。swing 必须收盘确认；
  // 未收盘 K 仅经 price 提供"实时触发"，事件以 realtime 标注，收盘后转 confirmed。
  const closed = candles.filter((k) => !k.closeTime || k.closeTime <= now);
  const labeled = analyzeSwings(findSwings(closed, left, right));
  const structure = buildStructure(labeled);
  const last = candles[candles.length - 1];
  const lastClosed = !last || !last.closeTime || last.closeTime <= now;

  // 判定价：优先实时 price（进行中提示），缺省末根 close（收盘确认）
  const p = price != null ? price : last ? last.close : null;

  const events = [];
  const direction = structure.direction;
  const lastHigh = structure.lastHigh;
  const lastLow = structure.lastLow;

  // BOS：顺趋势（或 NEUTRAL 首次突破）打破最近 swing
  if (p != null && lastHigh && p > lastHigh.price && (direction === "BULLISH" || direction === "NEUTRAL")) {
    events.push(mkEvent("BOS", "UP", lastHigh.price, p, lastHigh.index, `Broke recent swing high ${lastHigh.price}`, lastClosed, !lastClosed && price != null));
  } else if (p != null && lastLow && p < lastLow.price && (direction === "BEARISH" || direction === "NEUTRAL")) {
    events.push(mkEvent("BOS", "DOWN", lastLow.price, p, lastLow.index, `Broke recent swing low ${lastLow.price}`, lastClosed, !lastClosed && price != null));
  }

  // MSS：反势打破最近 swing（BULLISH 跌破最近 swing low / BEARISH 突破最近 swing high）
  if (direction === "BULLISH" && p != null && lastLow && p < lastLow.price) {
    events.push(mkEvent("MSS", "DOWN", lastLow.price, p, lastLow.index, `Broke recent swing low ${lastLow.price} — structure shift`, lastClosed, !lastClosed && price != null));
  } else if (direction === "BEARISH" && p != null && lastHigh && p > lastHigh.price) {
    events.push(mkEvent("MSS", "UP", lastHigh.price, p, lastHigh.index, `Broke recent swing high ${lastHigh.price} — structure shift`, lastClosed, !lastClosed && price != null));
  }

  return {
    direction,
    structureStatus: events.some((e) => e.type === "MSS") ? "INVALIDATED" : "VALID",
    structureLayer: {
      internal: {
        trend: direction,
        lastHigh: structure.lastHigh ? { type: "HIGH", price: structure.lastHigh.price, label: structure.lastHigh.label, index: structure.lastHigh.index } : null,
        lastLow: structure.lastLow ? { type: "LOW", price: structure.lastLow.price, label: structure.lastLow.label, index: structure.lastLow.index } : null,
        protectedLow: structure.protectedLow,
        protectedHigh: structure.protectedHigh,
      },
      external: { high: structure.externalSwingHigh, low: structure.externalSwingLow },
    },
    events,
    lastEvent: events.length ? events[events.length - 1] : null,
  };
}

/**
 * 历史扫描：最近 lookback 根已收盘 K 内出现的 MSS/BOS 事件（时间升序，去重）。
 * 对每根已收盘 K 用"当时子序列 + 该 K 的 close"重新判定——严格收盘确认（close beyond），
 * wick 插针不会进入历史事件。
 *
 * @param {Array} candles K 线（时间升序）
 * @param {Object} [opt]
 * @param {number} [opt.lookback=50] 回看窗口（根 K）
 * @param {number} [opt.left=2] swing 左侧确认 K 数（5m 用 1）
 * @param {number} [opt.right=2] swing 右侧确认 K 数（5m 用 1）
 * @returns {Array<{type,direction,level,price,swingIndex,atIndex,time,reason,confirmed}>}
 */
export function scanStructureEvents(candles, { lookback = 50, left = 2, right = 2 } = {}) {
  const now = Date.now();
  const closed = candles.filter((k) => k.closeTime <= now);
  if (closed.length < left + right + 1) return [];

  const startIdx = Math.max(0, closed.length - lookback);
  const events = [];
  for (let i = startIdx; i < closed.length; i++) {
    const r = detectStructureEvents(closed.slice(0, i + 1), { left, right });
    for (const e of r.events) {
      if (!e.confirmed) continue; // 只保留收盘确认事件
      events.push({ ...e, atIndex: i, time: closed[i].closeTime });
    }
  }

  // 去重：同类型同方向且 level 接近的连续事件合并（保留最后一条，即该事件的终点）
  const deduped = [];
  for (const e of events) {
    const last = deduped[deduped.length - 1];
    if (last && last.type === e.type && last.direction === e.direction && Math.abs(last.level - e.level) / last.level < 0.0005) {
      last.price = e.price;
      last.atIndex = e.atIndex;
      last.time = e.time;
      continue;
    }
    deduped.push(e);
  }
  return deduped;
}
