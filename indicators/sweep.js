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
import { marketNow } from "../utils/marketClock.js";
import { isLiquidityTakenByClose } from "./liquidity.js";
import { isIctValidFvg } from "./pdArray.js";
import { causalRangeId, sameCausalIdentity } from "./causalIdentity.js";

/**
 * Judas Swing 工程窗口：纽约当地 09:30-11:00。直接使用 America/New_York，
 * DST 切换周也不会产生一小时偏差。该窗口是 session 过滤器，不属于流动性池定义。
 * @param {Date} [now] 测试可注入
 */
export function isJudasWindow(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(now);
  const p = Object.fromEntries(parts.map((item) => [item.type, item.value]));
  if (["Sat", "Sun"].includes(p.weekday)) return false;
  const minute = Number(p.hour) * 60 + Number(p.minute);
  return minute >= 9 * 60 + 30 && minute < 11 * 60;
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
function detectSingleSweep(h5m, buySide, sellSide, price, window = 48, bias = null, { eventTimeAllowed = null } = {}) {
  const now = marketNow();
  const cur = h5m[h5m.length - 1];
  const eventAllowed = (k) => !!k && (!eventTimeAllowed || eventTimeAllowed(k.time));

  /** 透传流动性位的形成时间（lv 无 time/date 时省略，不产生 undefined 字段） */
  const levelMeta = (lv, eventCandle) => {
    const m = {};
    if (lv.time != null) m.levelTime = lv.time;
    if (lv.date != null) m.levelDate = lv.date;
    // Range identity becomes immutable only if the range already existed when the
    // event formed.  A later polling cycle may attach a new current range to the
    // same level, but it must not relabel an older historical sweep.
    const eventTime = eventCandle?.time ?? null;
    const rangeActiveFrom = lv.rangeActiveFrom ?? lv.rangeSelectedAt ?? null;
    const ownsEvent = lv.originRangeId != null || (lv.rangeId != null
      && rangeActiveFrom != null && eventTime != null && eventTime >= rangeActiveFrom);
    const originRangeId = ownsEvent ? (lv.originRangeId ?? lv.rangeId) : null;
    if (originRangeId != null) {
      m.originRangeId = originRangeId;
      m.rangeId = originRangeId;
      if (lv.rangeVersion != null) m.rangeVersion = lv.rangeVersion;
    }
    if (lv.rangeClass != null) m.rangeClass = lv.rangeClass;
    if (lv.tradingDayId != null) m.levelTradingDayId = lv.tradingDayId;
    return m;
  };

  /** 扫损事件必须在位形成之后：lv.time 为位形成 K 的开盘时间，扫损 K 若早于它，
   *  不可能"扫这个位"（CYSUSDT 08/15 02:03 误报：00:00 形成的内部摆动低点被 08/14 22:15
   *  的刺破匹配成扫损，时间倒挂）。无 time 的位（如 EQH）不做约束。 */
  const formedAfter = (lv, k) => {
    const activeFrom = lv.activeFrom ?? lv.time;
    return activeFrom == null || k.time >= activeFrom;
  };

  // 流动性位是否早已被消费（位形成之后任一根已收盘 K 收在 level 外侧或恰好收于 level）：
  //   BSL 只要收在 level 上方/等于 level → 该位已破位/被拿走，之后插针只是回测旧位，不算新事件；SSL 对称。
  // 等号必须计入：L1 本身用 close >= / <= level 判定“拿走但未收回”，若这里仍用严格不等号，
  // 首根恰好收在 level 的 L1 会在后续 K 再次生成新 time key，造成同一流动性池连续通报。
  // 只认位形成之后的收盘（wick 刺破不算消费，与扫损"收回"语义一致）。
  // 位形成之前的历史 K 收在 level 外侧不是对本位的消费——否则"低于历史高点"的内部摆动位/PDH
  // 会被永久判为已消费，扫损永不报（08/15 扫损骤减根因：42 个 ACTIVE 位被吞、DOGE/NBIS 漏报）。
  const alreadyTaken = (lv, isBuy, upToIndex) => {
    const from = lv.activeFrom ?? lv.time ?? 0; // swing 用右侧确认 K 收盘；其他位沿用形成时间
    for (let i = 0; i < upToIndex; i++) {
      const k = h5m[i];
      if (!eventAllowed(k)) continue;
      if (k.closeTime > now) continue;
      if (k.time < from) continue; // 位形成前的 K 不构成对本位的消费
      if (isLiquidityTakenByClose(k.close, lv.price, isBuy)) return true;
    }
    return false;
  };

  // 同一流动性池首次完成“刺破并收回”后即视为已 raid；后续 K 再刺同一价格不是新池。
  // 跨根收回的第二根仍属于第一次 raid，因此仅检查在当前候选 K 之前已经完整结束的事件。
  const alreadySwept = (lv, isBuy, upToIndex) => {
    const from = lv.activeFrom ?? lv.time ?? 0;
    for (let i = 0; i < upToIndex; i++) {
      const k = h5m[i];
      if (!eventAllowed(k) || k.closeTime > now || k.time < from) continue;
      const pierced = isBuy ? k.high > lv.price : k.low < lv.price;
      const reclaimed = isBuy ? k.close < lv.price : k.close > lv.price;
      if (pierced && reclaimed) return true;
      const next = h5m[i + 1];
      if (pierced && eventAllowed(next) && i + 1 < upToIndex && next.closeTime <= now) {
        const nextReclaimed = isBuy ? next.close < lv.price : next.close > lv.price;
        if (nextReclaimed) return true;
      }
    }
    return false;
  };

  const unavailable = (lv, isBuy, upToIndex) =>
    alreadyTaken(lv, isBuy, upToIndex) || alreadySwept(lv, isBuy, upToIndex);

  // 1) 实时：进行中的 K 已刺破流动性位，且当前最新价已收回（BSL：price 跌回 level 下；SSL：price 升回 level 上）
  if (eventAllowed(cur) && cur.closeTime > now && price != null) {
    const lastIdx = h5m.length - 1;
    for (const lv of buySide || []) {
      if (cur.high > lv.price && price < lv.price && formedAfter(lv, cur) && !unavailable(lv, true, lastIdx)) {
        return { side: "BSL", type: lv.type, level: lv.price, sweptPrice: cur.high, close: price, time: cur.time, key: `${cur.time}_BSL`, realtime: true, judas: judasOf("BSL", bias) && isJudasWindow(new Date(cur.time)), ...levelMeta(lv, cur) };
      }
    }
    for (const lv of sellSide || []) {
      if (cur.low < lv.price && price > lv.price && formedAfter(lv, cur) && !unavailable(lv, false, lastIdx)) {
        return { side: "SSL", type: lv.type, level: lv.price, sweptPrice: cur.low, close: price, time: cur.time, key: `${cur.time}_SSL`, realtime: true, judas: judasOf("SSL", bias) && isJudasWindow(new Date(cur.time)), ...levelMeta(lv, cur) };
      }
    }
  }

  // 2) 已收盘确认：最近 window 根内刺破后收回（从近到远，取最近一次）
  const closed = h5m.filter((k) => k.closeTime <= now && eventAllowed(k));
  const recent = closed.slice(-window);
  for (let i = recent.length - 1; i >= 0; i--) {
    const k = recent[i];
    const idx = h5m.indexOf(k);
    for (const lv of buySide || []) {
      // 单根内完成：本根刺破且收盘收回下方
      if (k.high > lv.price && k.close < lv.price && formedAfter(lv, k) && !unavailable(lv, true, idx)) {
        return { side: "BSL", type: lv.type, level: lv.price, sweptPrice: k.high, close: k.close, time: k.time, key: `${k.time}_BSL`, realtime: false, closedTime: k.closeTime, judas: judasOf("BSL", bias) && isJudasWindow(new Date(k.time)), ...levelMeta(lv, k) };
      }
      // V2.7 跨根收回：本根刺破但收盘未收回（仍在上方），次根（已收盘）收回下方也算 BSL。
      // ICT 中"插针式扫损"常在 1-2 根内完成；跨根形态比突破回踩更接近扫损语义。
      const next = h5m[idx + 1];
      if (k.high > lv.price && k.close >= lv.price && eventAllowed(next) && next.closeTime <= now && next.close < lv.price && formedAfter(lv, k) && !unavailable(lv, true, idx)) {
        return { side: "BSL", type: lv.type, level: lv.price, sweptPrice: k.high, close: next.close, time: k.time, reclaimTime: next.time, key: `${k.time}_BSL`, realtime: false, closedTime: next.closeTime, judas: judasOf("BSL", bias) && isJudasWindow(new Date(k.time)), ...levelMeta(lv, k) };
      }
    }
    for (const lv of sellSide || []) {
      // 单根内完成：本根刺破且收盘收回上方
      if (k.low < lv.price && k.close > lv.price && formedAfter(lv, k) && !unavailable(lv, false, idx)) {
        return { side: "SSL", type: lv.type, level: lv.price, sweptPrice: k.low, close: k.close, time: k.time, key: `${k.time}_SSL`, realtime: false, closedTime: k.closeTime, judas: judasOf("SSL", bias) && isJudasWindow(new Date(k.time)), ...levelMeta(lv, k) };
      }
      // V2.7 跨根收回：本根刺破但收盘未收回（仍在下方），次根（已收盘）收回上方也算 SSL。
      const next = h5m[idx + 1];
      if (k.low < lv.price && k.close <= lv.price && eventAllowed(next) && next.closeTime <= now && next.close > lv.price && formedAfter(lv, k) && !unavailable(lv, false, idx)) {
        return { side: "SSL", type: lv.type, level: lv.price, sweptPrice: k.low, close: next.close, time: k.time, reclaimTime: next.time, key: `${k.time}_SSL`, realtime: false, closedTime: next.closeTime, judas: judasOf("SSL", bias) && isJudasWindow(new Date(k.time)), ...levelMeta(lv, k) };
      }
    }
  }

  // 3) L1 LIQUIDITY_TAKEN：已经刺破流动性，但尚未满足同根/次根收回。
  // 它只表示 stops 被触发，不等于反转，也不进入旧版 detectSweeps/AMD 语义。
  if (eventAllowed(cur) && cur.closeTime > now && price != null) {
    const lastIdx = h5m.length - 1;
    for (const lv of buySide || []) {
      if (cur.high > lv.price && price >= lv.price && formedAfter(lv, cur) && !unavailable(lv, true, lastIdx)) {
        return { side: "BSL", type: lv.type, level: lv.price, sweptPrice: cur.high, close: price, time: cur.time, key: `${cur.time}_BSL`, realtime: true, reclaimed: false, judas: false, ...levelMeta(lv, cur) };
      }
    }
    for (const lv of sellSide || []) {
      if (cur.low < lv.price && price <= lv.price && formedAfter(lv, cur) && !unavailable(lv, false, lastIdx)) {
        return { side: "SSL", type: lv.type, level: lv.price, sweptPrice: cur.low, close: price, time: cur.time, key: `${cur.time}_SSL`, realtime: true, reclaimed: false, judas: false, ...levelMeta(lv, cur) };
      }
    }
  }
  for (let i = recent.length - 1; i >= 0; i--) {
    const k = recent[i];
    const idx = h5m.indexOf(k);
    for (const lv of buySide || []) {
      if (k.high > lv.price && k.close >= lv.price && formedAfter(lv, k) && !unavailable(lv, true, idx)) {
        return { side: "BSL", type: lv.type, level: lv.price, sweptPrice: k.high, close: k.close, time: k.time, key: `${k.time}_BSL`, realtime: false, closedTime: k.closeTime, reclaimed: false, judas: false, ...levelMeta(lv, k) };
      }
    }
    for (const lv of sellSide || []) {
      if (k.low < lv.price && k.close <= lv.price && formedAfter(lv, k) && !unavailable(lv, false, idx)) {
        return { side: "SSL", type: lv.type, level: lv.price, sweptPrice: k.low, close: k.close, time: k.time, key: `${k.time}_SSL`, realtime: false, closedTime: k.closeTime, reclaimed: false, judas: false, ...levelMeta(lv, k) };
      }
    }
  }
  return null;
}

export const LIQUIDITY_EVENT_LEVELS = Object.freeze({
  TAKEN: { tier: 1, stage: "LIQUIDITY_TAKEN" },
  RAID: { tier: 2, stage: "RECLAIMED_RAID" },
  CONFIRMED: { tier: 3, stage: "ICT_2022_CONFIRMED" },
});

const LIQUIDITY_SOURCE_PRIORITY = [
  "EXTERNAL_HIGH", "EXTERNAL_LOW",
  "PWH", "PWL", "PDH", "PDL",
  "EQH", "EQL", "PRE_MARKET_HIGH", "PRE_MARKET_LOW", "ASIA_HIGH", "ASIA_LOW",
  "INTERNAL_HIGH", "INTERNAL_LOW",
];

function sourceRank(type) {
  const rank = LIQUIDITY_SOURCE_PRIORITY.indexOf(type);
  return rank < 0 ? LIQUIDITY_SOURCE_PRIORITY.length : rank;
}

/** 同一根 K 对同一价位的多个来源只是一个流动性池，合并来源后只通报一次。 */
function mergeCoincidentLiquidityEvents(events) {
  const groups = [];
  const samePrice = (a, b) => Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b), 1) * 1e-9;
  for (const event of events || []) {
    let group = groups.find((items) => {
      const first = items[0];
      return first.side === event.side
        && causalRangeId(first) === causalRangeId(event)
        && first.time === event.time
        && (first.reclaimTime ?? null) === (event.reclaimTime ?? null)
        && samePrice(first.level, event.level);
    });
    if (!group) {
      group = [];
      groups.push(group);
    }
    group.push(event);
  }

  return groups.map((items) => {
    const primary = [...items].sort((a, b) => sourceRank(a.type) - sourceRank(b.type))[0];
    const levelTypes = [...new Set(items.map((item) => item.type))].sort((a, b) => sourceRank(a) - sourceRank(b));
    const sourceBaseKeys = [...new Set(items.map((item) => item.baseKey).filter(Boolean))];
    const sourcePreviousBaseKeys = [...new Set(items.map((item) => item.previousBaseKey).filter(Boolean))];
    return classifyLiquidityEvent({ ...primary, levelTypes, sourceBaseKeys, sourcePreviousBaseKeys });
  });
}

/** 根据收回、位移与 MSS 证据给事件定级；返回新对象，不修改调用方输入。 */
export function classifyLiquidityEvent(event) {
  if (!event) return null;
  const mss = event.mss5m?.lastEvent;
  const level = event.reclaimed === false
    ? LIQUIDITY_EVENT_LEVELS.TAKEN
    : mss?.confirmedByDisplacement
      && sameCausalIdentity(event, mss)
      && sameCausalIdentity(mss, event.confirmationFvg, { requireDisplacement: true })
      && isIctValidFvg(event.confirmationFvg)
      ? LIQUIDITY_EVENT_LEVELS.CONFIRMED
      : LIQUIDITY_EVENT_LEVELS.RAID;
  const baseKey = event.baseKey || event.key;
  return { ...event, ...level, baseKey, key: `${baseKey}_${level.stage}` };
}

/**
 * 返回每个独立流动性池在窗口内的首次流动性事件（L1 taken / L2 raid），按时间升序。
 * 不同价位分别返回；同一根 K 扫到的同价来源会合并为一个池并保留 levelTypes。
 * legacyKey / sourceBaseKeys 用于兼容旧状态与合并前的来源 key。
 */
export function detectSweepEvents(h5m, buySide, sellSide, price, window = 48, bias = null, options = {}) {
  const events = [];
  const seenPools = new Set();
  const collect = (lv, isBuy) => {
    if (!lv || lv.price == null) return;
    const side = isBuy ? "BSL" : "SSL";
    const pool = `${side}_${lv.originRangeId || lv.rangeId || "NO_RANGE"}_${lv.type || "LEVEL"}_${lv.price}`;
    if (seenPools.has(pool)) return;
    seenPools.add(pool);
    const event = detectSingleSweep(h5m, isBuy ? [lv] : [], isBuy ? [] : [lv], price, window, bias, options);
    if (!event) return;
    const legacyKey = event.key;
    // rangeId 上线前的 baseKey，用于读取既有 state.sweepPushed，避免部署首轮重推旧 L2/L3。
    const previousBaseKey = `${legacyKey}_${lv.type || "LEVEL"}_${lv.price}`;
    const baseKey = `${legacyKey}_${causalRangeId(event) || "NO_RANGE"}_${lv.type || "LEVEL"}_${lv.price}`;
    events.push(classifyLiquidityEvent({ ...event, legacyKey, previousBaseKey, baseKey, key: baseKey }));
  };
  for (const lv of buySide || []) collect(lv, true);
  for (const lv of sellSide || []) collect(lv, false);
  return mergeCoincidentLiquidityEvents(events).sort((a, b) => (a.closedTime ?? a.time) - (b.closedTime ?? b.time));
}

/** 兼容旧调用：仍返回最近一个事件，并保留旧版 `${time}_${side}` key。 */
export function detectSweeps(h5m, buySide, sellSide, price, window = 48, bias = null, options = {}) {
  const event = detectSweepEvents(h5m, buySide, sellSide, price, window, bias, options).filter((item) => item.tier >= 2).at(-1);
  if (!event) return null;
  const { legacyKey, ...legacy } = event;
  return { ...legacy, key: legacyKey };
}
