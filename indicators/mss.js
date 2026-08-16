/**
 * mss.js — MSS / BOS 检测（P1-B）
 *
 * ICT 2022 结构观：结构变化不取决于"看到 HH/HL 组合"，而取决于"哪个 swing 被打破"。
 *
 *   BOS（Break of Structure，顺势突破 → 趋势延续）：
 *     BULLISH : close > 最近 Swing High（lastHigh）→ BOS_UP
 *     BEARISH : close < 最近 Swing Low（lastLow） → BOS_DOWN
 *   反势结构破坏（structure break）：
 *     BULLISH : close < 最近 Swing Low（lastLow） → STRUCTURE_BREAK_DOWN
 *     BEARISH : close > 最近 Swing High（lastHigh）→ STRUCTURE_BREAK_UP
 *   ICT MSS：上述反势收盘破坏还必须由 displacement 交付。普通贴线收破仍会让旧结构
 *   失效，但语义字段 semanticType=STRUCTURE_BREAK，不冒充课程意义上的 MSS。
 *
 * 触发基准用"最近 swing"（lastHigh / lastLow），与 V1.4 的 protectedLow/High 职责分开：
 *   protectedLow/High（最后一个 HH/LL 前的结构启动位）仅保留在 structureLayer 中供 4H
 *   失效位审计，不再作为 MSS 触发基准——否则最新 HL/LH 在最后一个 HH/LL 之后时，
 *   结构破坏会被推迟到更深的位；MSS 还需要该突破由 displacement 交付。
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
 *
 * 位移确认（P1）：close beyond 只是"最小结构转移"，ICT 2022 更关注"带位移"的结构转移。
 * 每个事件额外输出 confirmedByDisplacement：
 *   触发 K（或紧邻前一已收盘根）为同向位移 K（大实体 + 单边收盘交付，见 displacement.js；
 *   FVG/结构突破为标签）且位移 K 收盘跨越本次被突破的 swing 位 → true；
 *   否则（低动能、贴线式突破）→ false。
 * CHAIN 链至少要求 MSS 突破腿为位移确认；FVG 若由下一根 K 才形成，则单独等待该
 * 三根结构确认，不能反过来延迟或否定位移 K 收盘时已经成立的 MSS。
 */

import { findSwings, analyzeSwings } from "./swing.js";
import { buildStructure } from "./structure.js";
import { findDisplacements } from "./displacement.js";
import { marketNow } from "../utils/marketClock.js";

function mkEvent(type, direction, level, price, swingIndex, reason, confirmed, realtime, confirmedByDisplacement) {
  // 事件基准均为最近 swing（lastHigh/lastLow）→ INTERNAL；external 位只存在于 structureLayer 审计
  const ictMss = type === "MSS" && confirmed === true && confirmedByDisplacement === true;
  return {
    type,
    semanticType: type === "MSS" ? (ictMss ? "MSS" : "STRUCTURE_BREAK") : type,
    ictMss,
    direction,
    level,
    levelType: "INTERNAL",
    price,
    swingIndex,
    reason,
    confirmed,
    realtime,
    confirmedByDisplacement,
  };
}

/**
 * 检测"当前时刻"的 MSS / BOS 事件。
 *
 * @param {Array} candles K 线（时间升序；{time,open,high,low,close,closeTime}）
 * @param {Object} [opt]
 * @param {number} [opt.price] 实时触发价（末根未收盘时用；缺省取末根 close）
 * @param {number} [opt.left=2]  swing 左侧确认 K 数（5m 用 1）
 * @param {number} [opt.right=2] swing 右侧确认 K 数（5m 用 1）
 * @param {Array} [opt.displacements] 预计算的位移 K 列表（findDisplacements 输出；高频调用
 *   （scanStructureEvents）时传入避免重复计算，缺省内部计算一次
 * @returns {{
 *   direction: "BULLISH"|"BEARISH"|"NEUTRAL",  // swing 判定的当前结构方向
 *   structureStatus: "VALID"|"INVALIDATED",     // 最近 swing 是否被反势打破（= 是否已触发 MSS）
 *   structureLayer: { internal, external },     // Internal / External 分层
 *   events: Array,                              // 当前触发的 MSS/BOS 事件（含 confirmedByDisplacement）
 *   lastEvent: Object|null                      // 最近一次事件（消息层直接渲染）
 * }}
 */
export function detectStructureEvents(candles, {
  price,
  left = 2,
  right = 2,
  displacements,
  precomputedStructure = null,
  displacementMap = null,
  endIndex = null,
} = {}) {
  const now = marketNow();
  // 修复（等待 K 收盘）：swing 判定只用已收盘 K。
  // 进行中 K 的 high/low/close 会随实时成交变动，若参与 Pivot 右侧确认，
  // 会使倒数第 2 根的 swing 状态随实时价漂移（同一根 K 时而确认时而否决），
  // 进而污染 lastHigh/lastLow 与 MSS/BOS 判定。swing 必须收盘确认；
  // 未收盘 K 仅经 price 提供"实时触发"，事件以 realtime 标注，收盘后转 confirmed。
  // 生命周期冷重建会逐根调用本函数。它已经增量维护了当根可见的 swing/structure，
  // 并预计算了位移索引；传入这些只读上下文可避免 5000 根历史出现 O(n²) 重扫。
  const replayIndex = Number.isInteger(endIndex) ? Math.min(endIndex, candles.length - 1) : null;
  const closed = precomputedStructure ? null : candles.filter((k) => !k.closeTime || k.closeTime <= now);
  const labeled = precomputedStructure ? null : analyzeSwings(findSwings(closed, left, right));
  const structure = precomputedStructure || buildStructure(labeled);
  const last = replayIndex == null ? candles[candles.length - 1] : candles[replayIndex];
  const lastClosed = replayIndex != null || !last || !last.closeTime || last.closeTime <= now;

  // 判定价：已收盘事件只能使用该 K 的 close。price 仅用于末根仍进行中时的实时预警，
  // 防止调用方把最新成交价与“已收盘数组”一起传入后伪造 confirmed MSS/BOS。
  const p = lastClosed ? (last ? last.close : null) : price != null ? price : last ? last.close : null;

  // 位移索引（index → {index, dir, confirmationIndex, close, fvg}）：触发事件的那根已收盘 K
  // （或紧邻前一已收盘根）为同向位移 K → 该事件"带位移"。位移在自身收盘确认；
  // confirmationIndex 只表示其关联三根 FVG 的确认 K，不能用它延迟 MSS。
  // 防前视：若 FVG 需要下一根确认，在该根到来前只附加 displacement，不附加 displacementFvg。
  const dispSet = displacementMap || new Map();
  if (!displacementMap) {
    const dispList = displacements ?? findDisplacements(closed);
    for (const d of dispList) {
      dispSet.set(d.index, {
        index: d.index,
        dir: d.direction,
        confirmationIndex: d.confirmationIndex,
        close: d.close,
        fvg: d.fvg,
      });
    }
  }
  const lastIdx = replayIndex == null ? closed.length - 1 : replayIndex;
  const dNear = (dir) => {
    const d0 = dispSet.get(lastIdx);
    const d1 = dispSet.get(lastIdx - 1);
    if (d0 && d0.dir === dir) return d0;
    if (d1 && d1.dir === dir) return d1;
    return null;
  };
  // 位移腿绑定（P1）：位移必须实际跨越被突破的 swing 位——位移 K 收盘在 swing 另一侧。
  // 结构突破已降级为标签（可能为 null），不能依赖 structureBreak.level 匹配；位移 K 自身
  // 收盘越过该位，才是"这次突破的动能腿"。
  const dispBeyondLevel = (d, dir, swingPrice) =>
    d.close != null && swingPrice != null && (dir === "UP" ? d.close > swingPrice : d.close < swingPrice);

  /**
   * 统一绑定位移证据到结构事件（MSS/BOS）：
   *   - confirmedByDisplacement：事件由位移腿确认
   *   - atIndex：事件标在位移 K（而非确认/触发 K）——位移 K 的突破真实发生过
   *   - displacementIndex / displacementConfirmationIndex / displacementFvg：
   *     供 CHAIN 精确匹配"该位移产生的执行区"——FVG 按确认 K（confirmationIndex）对齐，
   *     OB 按位移 K（displacementIndex）对齐，避免用旧 FVG/OB 拼接虚假链条
   * @param {Object} event mkEvent 输出
   * @param {Object|null} d 匹配的位移（dispSet 项）；null 时原样返回
   */
  function attachDisplacement(event, d) {
    if (!d) return event;
    event.confirmedByDisplacement = true;
    if (event.type === "MSS" && event.confirmed) {
      event.semanticType = "MSS";
      event.ictMss = true;
    }
    event.atIndex = d.index;
    event.displacementIndex = d.index;
    const fvgConfirmed = d.fvg && d.confirmationIndex <= lastIdx;
    event.displacementConfirmationIndex = fvgConfirmed ? d.confirmationIndex : null;
    event.displacementFvg = fvgConfirmed ? d.fvg : null;
    return event;
  }

  const events = [];
  const direction = structure.direction;
  const lastHigh = structure.lastHigh;
  const lastLow = structure.lastLow;

  // BOS：顺趋势（或 NEUTRAL 首次突破）打破最近 swing
  // P1：broke 分支用当前 p 判定（收盘确认/实时）；dispBroke 分支是"上一根位移已确认，
  // 但当前 K 收盘已收回 swing 内"——位移 K 的突破真实发生过，事件仍成立（price 用位移 K
  // 收盘价，atIndex 标位移 K 而非确认 K）。
  if (lastHigh && (direction === "BULLISH" || direction === "NEUTRAL")) {
    const d = dNear("UP");
    if (p != null && p > lastHigh.price) {
      // P1：位移确认必须匹配突破价位——附近同向位移不一定突破的是同一个 swing
      const matchedD = d && dispBeyondLevel(d, d.dir, lastHigh.price) ? d : null;
      events.push(attachDisplacement(mkEvent("BOS", "UP", lastHigh.price, p, lastHigh.index, `Broke recent swing high ${lastHigh.price}`, lastClosed, !lastClosed && price != null, !!matchedD), matchedD));
    } else if (lastClosed && d && dispBeyondLevel(d, d.dir, lastHigh.price)) {
      events.push(attachDisplacement(mkEvent("BOS", "UP", lastHigh.price, d.close, lastHigh.index, `Displacement broke swing high ${lastHigh.price}`, true, false, true), d));
    }
  } else if (lastLow && (direction === "BEARISH" || direction === "NEUTRAL")) {
    const d = dNear("DOWN");
    if (p != null && p < lastLow.price) {
      const matchedD = d && dispBeyondLevel(d, d.dir, lastLow.price) ? d : null;
      events.push(attachDisplacement(mkEvent("BOS", "DOWN", lastLow.price, p, lastLow.index, `Broke recent swing low ${lastLow.price}`, lastClosed, !lastClosed && price != null, !!matchedD), matchedD));
    } else if (lastClosed && d && dispBeyondLevel(d, d.dir, lastLow.price)) {
      events.push(attachDisplacement(mkEvent("BOS", "DOWN", lastLow.price, d.close, lastLow.index, `Displacement broke swing low ${lastLow.price}`, true, false, true), d));
    }
  }

  // MSS：反势打破最近 swing（BULLISH 跌破最近 swing low / BEARISH 突破最近 swing high）
  if (direction === "BULLISH" && lastLow) {
    const d = dNear("DOWN");
    if (p != null && p < lastLow.price) {
      const matchedD = d && dispBeyondLevel(d, d.dir, lastLow.price) ? d : null;
      events.push(attachDisplacement(mkEvent("MSS", "DOWN", lastLow.price, p, lastLow.index, `Broke recent swing low ${lastLow.price} — structure shift`, lastClosed, !lastClosed && price != null, !!matchedD), matchedD));
    } else if (lastClosed && d && dispBeyondLevel(d, d.dir, lastLow.price)) {
      events.push(attachDisplacement(mkEvent("MSS", "DOWN", lastLow.price, d.close, lastLow.index, `Displacement broke swing low ${lastLow.price} — structure shift`, true, false, true), d));
    }
  } else if (direction === "BEARISH" && lastHigh) {
    const d = dNear("UP");
    if (p != null && p > lastHigh.price) {
      const matchedD = d && dispBeyondLevel(d, d.dir, lastHigh.price) ? d : null;
      events.push(attachDisplacement(mkEvent("MSS", "UP", lastHigh.price, p, lastHigh.index, `Broke recent swing high ${lastHigh.price} — structure shift`, lastClosed, !lastClosed && price != null, !!matchedD), matchedD));
    } else if (lastClosed && d && dispBeyondLevel(d, d.dir, lastHigh.price)) {
      events.push(attachDisplacement(mkEvent("MSS", "UP", lastHigh.price, d.close, lastHigh.index, `Displacement broke swing high ${lastHigh.price} — structure shift`, true, false, true), d));
    }
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
  const now = marketNow();
  const closed = candles.filter((k) => k.closeTime <= now);
  if (closed.length < left + right + 1) return [];

  const startIdx = Math.max(0, closed.length - lookback);
  // 位移预计算一次复用（位移三条件仅依赖已收盘 K，与扫描逐根共享同一视图）
  const displacements = findDisplacements(closed);
  const events = [];
  for (let i = startIdx; i < closed.length; i++) {
    const r = detectStructureEvents(closed.slice(0, i + 1), { left, right, displacements });
    for (const e of r.events) {
      if (!e.confirmed) continue; // 只保留收盘确认事件
      // 位移补事件（确认 K 收回 swing 内）携带 atIndex = 位移 K 索引，事件标在位移 K 而非确认 K
      const at = e.atIndex ?? i;
      events.push({ ...e, atIndex: at, time: closed[at].closeTime });
    }
  }

  // 去重：同类型同方向且 level 接近的连续事件合并——保留首次突破起点（atIndex/time），
  // 另设 lastSeenAt/lastSeenTime 记录"最后仍处于突破侧"的持续状态。
  // P1：不得用合并覆盖事件起点——否则连续同 level 突破会把 atIndex/time 不断推后（价格
  // 10:00 首次 MSS 突破、10:30 仍在 swing 外 → time 被改到 10:30），而 opportunity 用
  // `e.time >= sweepTime` 判定链条时序，时间被推后会伪造"Sweep(10:20) 在 MSS 之前"的 CHAIN。
  // 位移确认 OR 合并（任一腿为位移确认即成立），但不覆盖事件起点；位移腿字段（index/fvg）
  // 须同步自"位移确认的那条腿"，否则 confirmedByDisplacement=true 却 displacementIndex 为空，
  // opportunity 的 linkedToMss 匹配不上该腿产生的执行区。
  const deduped = [];
  for (const e of events) {
    const last = deduped[deduped.length - 1];
    if (last && last.type === e.type && last.direction === e.direction && Math.abs(last.level - e.level) / last.level < 0.0005) {
      last.price = e.price;
      last.lastSeenAt = e.atIndex;
      last.lastSeenTime = e.time;
      // 只允许“原突破腿的 FVG 延后一根确认”补齐位移证据；更晚的新位移不能回头
      // 美化第一次普通收破，否则会事后拼出并不存在的 Sweep→MSS 因果链。
      if (e.confirmedByDisplacement && e.displacementIndex === last.atIndex) {
        last.confirmedByDisplacement = true;
        if (last.type === "MSS") {
          last.semanticType = "MSS";
          last.ictMss = true;
        }
        last.displacementIndex = e.displacementIndex;
        last.displacementConfirmationIndex = e.displacementConfirmationIndex;
        last.displacementFvg = e.displacementFvg;
      } else if (e.confirmedByDisplacement) {
        last.laterDisplacementAt = e.displacementIndex;
      }
      continue;
    }
    deduped.push({ ...e, lastSeenAt: e.atIndex, lastSeenTime: e.time });
  }
  return deduped;
}
