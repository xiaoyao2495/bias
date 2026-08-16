/**
 * opportunity.js — 5m 机会扫描器（Monitor Step 4）
 *
 * 目标：把 4H 环境监控升级为 5m 机会发现。
 * 在 4H Bias 方向明确（BULLISH/BEARISH）的前提下，扫描 5m 层的 ICT 入场触发器：
 *
 *   RETRACE — 回踩同向 5m FVG/OB 后，5m 收盘收回关键位置或出现同向结构确认
 *   CHAIN   — 扫损 → 5m MSS（位移确认）→ 回踩对应执行区 → 5m 入场确认
 *   KEY_MSS — 4H 执行区内扫短线流动性 → 位移确认的 5m MSS；仅作 WATCH
 *
 * 一般结构证据（不直接产生入场）：MSS/BOS 仅建立"结构已转移/延续"的证据。
 * 关键位置的扫损后 MSS 可单独提示，但不会升级成可直接执行的入场信号。
 * BOS 后价格仍处突破侧就报"突破入场"容易追在位移末端——等价格回踩到该位移产生的
 * FVG/OB（RETRACE）才构成可执行机会。
 *
 * 环境过滤：4H bias 为 NEUTRAL 不出机会（无方向不交易）。
 * 评分（0-100）：环境（信心度/机会质量/活跃窗口/结构有效）× 信号类型权重 + 位置。
 *
 * 输入：
 *   env — analyzeSymbol 的摘要（bias/confidence/quality/session/structureStatus/sweep/price）
 *   m5  — 较长 5m 历史（建议 ≥1000 根 ≈ 3.5 天；swing 结构/执行区/MSS-BOS 历史需要）
 *
 * 纯函数模块：不拉数据、不推送，数据与推送由 runMonitor.js 编排。
 */
import { detectStructureEvents, scanStructureEvents } from "../indicators/mss.js";
import { findDisplacements } from "../indicators/displacement.js";
import { buildLiquiditySequences, LIQUIDITY_SEQUENCE_POLICIES, LIQUIDITY_SEQUENCE_STATUS } from "../indicators/liquiditySequence.js";
import { annotateFvgQuality, findFvgs, findOrderBlocks, annotatePDArray, isExecutableFvg } from "../indicators/pdArray.js";
import { marketNow } from "../utils/marketClock.js";
import { isExecutionSessionForProfile, resolveInstrumentProfile, tradingDayIdAt } from "../indicators/instrumentProfile.js";

// ---- 常量 ----
const ZONE_AGE_MAX = 60; // 执行区最大年龄（根 5m = 5 小时，太旧价值低）
const SWEEP_WINDOW_MS = 4 * 3600_000; // 扫损有效窗口（4 小时，与 sweep.js window=48 一致）
const CONFIRM_LOOKBACK = 3; // 执行区触碰/确认必须发生在最近 3 根已收盘 5m 内，避免复用陈旧触发
const M5_MS = 5 * 60_000;
// KEY_MSS 补发窗口：45 分钟（原 15 分钟过于苛刻——MSS 后 15min 内恰好同时满足
// 扫损 + 4H 执行区 + 追价 ≤0.5R 的时刻太少，导致关键位置 MSS 几乎从不推送）
export const KEY_MSS_MAX_AGE_MS = 45 * 60_000;
export const KEY_MSS_LOOKBACK = Math.ceil(KEY_MSS_MAX_AGE_MS / M5_MS); // 9 根（45min）
export const KEY_MSS_MAX_PROGRESS_R = 0.5;
export const KEY_MSS_MIN_REMAINING_R = 1;
/** 推送门槛：低于此分不推送（环境差/信号弱 = 噪声） */
export const OPP_MIN_SCORE = 60;

/**
 * 5m 结构图景：当前 swing 结构 + 最近执行区（FVG/OB）+ 最近 MSS/BOS 历史。
 * @param {Array} m5 5m K 线（时间升序，{time,open,high,low,close,closeTime}）
 * @param {number} [price] 当前价（实时 MSS/BOS 触发用；缺省用末根 close）
 * @returns {Object}
 */
export function computeM5Context(m5, price) {
  // P1：统一已收盘 K 基准。未收盘 K 的 high/low 实时变动会重绘 FVG/OB；
  // 且 FVG/OB（findFvgs/findOrderBlocks 直接扫传入数组）与 MSS 事件（mss.js 内部
  // filter 已收盘子集）若用不同数组，同一根 K 的 index 会错位（差 1），
  // CHAIN 的 linkedToMss 按 index 精确匹配会永远失败。
  const closed = m5.filter((k) => !k.closeTime || k.closeTime <= marketNow());
  if (closed.length < 3) {
    return { direction: "NEUTRAL", lastHigh: null, lastLow: null, pd: { fvg: [], ob: [] }, events: [], candles: closed };
  }
  const displacements = findDisplacements(closed);
  const structure = detectStructureEvents(closed, { price, left: 1, right: 1, displacements });
  const fvgs = findFvgs(closed);
  const events = scanStructureEvents(closed, { lookback: 50, left: 1, right: 1 });
  const obs = findOrderBlocks(closed, { displacements, structureEvents: events });
  // annotatePDArray 需要 range（dealing range）做 PREMIUM/DISCOUNT 标注；
  // 机会扫描只用 age/status，传 null 即可（location 为 null，不影响）。
  // ZONE_AGE_MAX=60，至少保留 80 个最近区域；旧版只留40个会在高波动时提前截掉仍在年龄窗内的 FVG。
  const activeObs = obs.filter((item) => item.executable === true);
  const pd = annotatePDArray({ fvg: fvgs.slice(-80), ob: activeObs.slice(-80) }, null, closed);
  pd.fvg = annotateFvgQuality(pd.fvg, closed, { displacements, structureEvents: events });
  return {
    direction: structure.direction,
    lastHigh: structure.structureLayer ? structure.structureLayer.internal.lastHigh : null,
    lastLow: structure.structureLayer ? structure.structureLayer.internal.lastLow : null,
    pd, // { fvg: [...], ob: [...] }，annotated：age/status
    events, // 最近 MSS/BOS（时间升序，收盘确认）
    candles: closed, // P1-3：执行区触碰与确认 K 必须使用同一组已收盘 5m
  };
}

/**
 * 扫描 5m 机会（顺 4H Bias 方向）。
 * @param {Object} p
 * @param {string} p.symbol
 * @param {Object} p.env analyzeSymbol 摘要（见文件头）
 * @param {Array} p.m5 较长 5m 历史
 * @returns {Array<{symbol,type,direction,entry,zone,trigger,score,key,time}>} 机会/观察信号列表（按评分降序）
 */
export function scanOpportunities({ symbol, env, m5 }) {
  // 兼容 monitor overview 的 { cur: { bias/... }, price/... } 结构；正式编排会先展开，
  // 此处再做防御，避免其他调用方误传嵌套环境时静默返回空机会。
  env = env?.cur ? { ...env, ...env.cur } : env;
  const bias = env?.bias;
  if (bias !== "BULLISH" && bias !== "BEARISH") return [];
  // 5m 触发只能执行在已确认、仍 ACTIVE 的 4H 推动区间内；RECENT 观察高低点
  // 不得借 AMD/Direction WATCH 绕过 Range 门禁生成 CHAIN/RETRACE/KEY_MSS。
  if (env.dealingRangeReady !== true) return [];
  const profile = env.instrumentProfile || resolveInstrumentProfile(symbol);
  const analysisTime = env.analysisTime ?? env.priceTime ?? (m5 || []).at(-1)?.closeTime ?? marketNow();
  // ICT 2022 时间与价格并重，但执行窗口必须服从品种制度：
  // US 股票关联只做 NY；24×7 Crypto 只做 London / NY。Asia 用于形成区间，不直接执行。
  if (!isExecutionSessionForProfile(profile, env.ictSession, analysisTime)) return [];
  // 机会必须属于同一交易日完整交付链；旧 AMD 状态、跨日证据或仅有位移都不能放行。
  const tradingDayId = tradingDayIdAt(analysisTime, profile);
  if (env.amd?.stage !== "DISTRIBUTION"
    || env.amd.direction !== bias
    || env.amd.tradingDayId !== tradingDayId
    || !env.amd.liquiditySequenceId) return [];
  if (!m5 || m5.length < 20) return [];

  const price = env.price;
  const ctx = computeM5Context(m5, price);
  const zones = collectZones(ctx, bias);

  const opps = [];
  // 关键位置 MSS 是“结构转向 WATCH”，不是直接入场：方向评级允许、但最终操作因等待
  // 4H 执行区而为 WAIT 时仍可提示。完整 RETRACE/CHAIN 继续严格服从最终 WATCH。
  // V2.6：方向可交易 = 决策层标签 WATCH（4H planR ≥ 1 的 WATCH_FOR_ENTRY）。
  // 注意 analyzeSymbol 摘要字段名是 decisionLabel（decision 是最终操作 WATCH/WAIT/NO_TRADE，
  // 受 execution READY 约束，常为 WAIT）；曾误用 directionDecision（不存在，恒 undefined）
  // 导致门禁形同虚设、RETRACE/CHAIN 从不扫描。三种写法兼容各调用方。
  const directionWatch =
    env.decisionLabel === "WATCH" ||
    env.directionDecision === "WATCH" ||
    env.decision === "WATCH";
  const keyMss = directionWatch ? detectKeyPositionMss({ env, ctx, bias }) : null;
  if (keyMss) opps.push(keyMss);
  // V2.6：CHAIN/RETRACE 门禁放宽到"方向可交易"（directionWatch = 4H planR ≥ 1）。
  // 原要求最终 decision === "WATCH"（execution READY），但 execution 依赖 4H dealing range
  // 顺位区，价格常不在顺位侧 → 真实运行几乎永远 WAIT → RETRACE（执行区回踩，本应最
  // 频繁）从不扫描。位置质量改由机会自身的确认条件把关（回踩 + 收盘确认/结构确认），
  // 不再叠加 4H execution；decision === "WATCH" 时行为不变（兼容旧测试）。
  if (!directionWatch) return finalizeOpportunities(opps, symbol, env);
  const chain = detectChain({ env, ctx, bias, price, zones });
  if (chain) opps.push(chain);
  const retrace = detectRetrace({ ctx, bias, price, zones });
  if (retrace) opps.push(retrace);

  return finalizeOpportunities(opps, symbol, env);
}

function finalizeOpportunities(opps, symbol, env) {
  for (const o of opps) {
    o.symbol = symbol;
    o.trade = buildTradePlan(o, env);
    if (o.type === "KEY_MSS" && o.trade) {
      o.marketState = assessKeyMssChase({ trade: o.trade, currentPrice: env.price, direction: o.direction });
    }
    o.score = scoreOpportunity(o, env);
  }
  return opps
    .filter((o) => o.trade)
    .filter((o) => o.type !== "KEY_MSS" || o.marketState?.eligible)
    .filter((o) => o.score >= OPP_MIN_SCORE)
    .sort((a, b) => b.score - a.score);
}

/**
 * 关键位置 MSS：4H 同向执行区内先扫短线逆向流动性，随后出现与 4H Bias 一致的
 * 已收盘且由 displacement 交付的 5m MSS。普通贴线收破只叫 STRUCTURE_BREAK，
 * 不以 KEY_MSS 名义通知。
 */
export function detectKeyPositionMss({ env, ctx, bias }) {
  const expected = bias === "BULLISH" ? "UP" : "DOWN";
  const event = [...(ctx.events || [])].reverse().find(
    (e) => e.type === "MSS" && e.direction === expected && e.confirmed
      && e.confirmedByDisplacement === true && e.ictMss !== false
      && isRecentKeyMss(e, ctx.candles || [])
  );
  if (!event) return null;
  const sweep = findLocalSweepBeforeMss(ctx.candles || [], event, bias);
  if (!sweep) return null;

  const zone = (env.executionZones || []).find((z) => {
    const direction = String(z.type || "").startsWith("BULLISH") ? "BULLISH" : String(z.type || "").startsWith("BEARISH") ? "BEARISH" : null;
    return direction === bias && sweep.candleLow <= z.top && sweep.candleHigh >= z.bottom;
  });
  if (!zone) return null;

  return {
    type: "KEY_MSS",
    direction: bias,
    entry: event.price,
    zone: { type: zone.type.includes("FVG") ? "4H FVG" : "4H OB", top: zone.top, bottom: zone.bottom },
    localSweep: sweep,
    confirmation: {
      type: "STRUCTURE_CONFIRMATION",
      eventType: "MSS",
      time: event.time,
      price: event.price,
      text: `5m MSS ${expected} 收盘确认`,
    },
    displacementConfirmed: event.confirmedByDisplacement === true,
    trigger: `4H关键执行区 → 扫${sweep.side} → 5m MSS ${expected}（位移确认）`,
    key: `KEY_MSS_${bias}_${event.level}_${event.time}`,
    time: event.time,
  };
}

/** KEY_MSS 只在确认后 45 分钟内有效（约 9 根已收盘 5m）；同时校验真实时间，防止陈旧行情补发。 */
export function isRecentKeyMss(event, candles, now = marketNow()) {
  const age = now - Number(event?.time);
  if (!Number.isFinite(age) || age < 0 || age > KEY_MSS_MAX_AGE_MS) return false;
  const eventIndex = candles.findIndex((k) => (k.closeTime ?? k.time) === event.time);
  return eventIndex >= 0 && eventIndex >= candles.length - KEY_MSS_LOOKBACK;
}

/**
 * KEY_MSS 追价过滤：超过确认价 0.5R 不补发；有第一目标时，当前剩余盈亏比至少保留 1R。
 * remainingR 使用“当前价→目标 / 当前价→原失效位”，反映现在追进去的真实空间。
 */
export function assessKeyMssChase({ trade, currentPrice, direction }) {
  const entry = Number(trade?.entry);
  const stop = Number(trade?.stop);
  const price = Number(currentPrice);
  const target = trade?.target == null ? null : Number(trade.target);
  const risk = Math.abs(entry - stop);
  if (![entry, stop, price].every(Number.isFinite) || !(risk > 0)) {
    return { eligible: false, progressR: null, remainingR: null, reason: "INVALID_PLAN" };
  }

  const favorableMove = direction === "BULLISH" ? price - entry : entry - price;
  const progressR = favorableMove / risk;
  const currentRisk = direction === "BULLISH" ? price - stop : stop - price;
  if (!(currentRisk > 0)) {
    return { eligible: false, progressR, remainingR: null, reason: "INVALIDATED" };
  }

  let remainingR = null;
  if (Number.isFinite(target)) {
    const remainingReward = direction === "BULLISH" ? target - price : price - target;
    remainingR = remainingReward / currentRisk;
  }
  if (progressR > KEY_MSS_MAX_PROGRESS_R) {
    return { eligible: false, progressR, remainingR, reason: "MOVED_TOO_FAR" };
  }
  if (remainingR != null && remainingR < KEY_MSS_MIN_REMAINING_R) {
    return { eligible: false, progressR, remainingR, reason: "INSUFFICIENT_REMAINING_R" };
  }
  return { eligible: true, progressR, remainingR, reason: null };
}

/** 找 MSS 前最近一次“刺破前方短线高/低后收回”的 5m K。 */
function findLocalSweepBeforeMss(candles, event, bias) {
  const eventIndex = candles.findIndex((k) => (k.closeTime ?? k.time) === event.time);
  if (eventIndex < 1) return null;
  const first = Math.max(1, eventIndex - 9); // MSS 前最多 45 分钟
  for (let i = eventIndex - 1; i >= first; i--) {
    const k = candles[i];
    const prior = candles.slice(Math.max(0, i - 6), i);
    if (!prior.length) continue;
    if (bias === "BEARISH") {
      const level = Math.max(...prior.map((x) => x.high));
      if (k.high > level && k.close < level) {
        return { side: "BSL", level, sweptPrice: k.high, time: k.time, candleHigh: k.high, candleLow: k.low };
      }
    } else {
      const level = Math.min(...prior.map((x) => x.low));
      if (k.low < level && k.close > level) {
        return { side: "SSL", level, sweptPrice: k.low, time: k.time, candleHigh: k.high, candleLow: k.low };
      }
    }
  }
  return null;
}

/**
 * 收集同向执行区池（5m FVG/OB）：同向 + 未过度消耗 + 足够新。
 * P1：FILLED（触及远端 = 缺口完全回补）的 FVG 彻底失效，无条件排除，不再作为回踩目标；
 * CE_REACHED（触及中点）仍保留参考价值，仅过旧的区放弃。
 */
function collectZones(ctx, bias) {
  const zones = [];
  const items = [...ctx.pd.fvg, ...ctx.pd.ob];
  for (const it of items) {
    if (it.direction !== bias) continue; // 只做同向执行区（BULLISH → 多头 FVG/OB）
    if (it.age > ZONE_AGE_MAX) continue;
    const executionStatus = it.executionStatus || it.status;
    // 这里是交易执行层，允许用 ATR/tick 宽度排除过窄区域；该门槛不参与上游
    // FVG 的 ictValid 或 L3/HTF 因果确认。wick 完全穿越仍表示原缺口已填补。
    if (it.type.includes("FVG") && !isExecutableFvg(it)) continue;
    if (!it.type.includes("FVG") && (it.ict !== true || it.executable === false || it.status === "INVALIDATED")) continue;
    if (executionStatus === "CE_REACHED" && it.age > 12) continue;
    const top = it.top ?? it.high;
    const bottom = it.bottom ?? it.low;
    if (top == null || bottom == null || top <= bottom) continue;
    // OB 暂无 ATR 质量元数据，沿用旧的 0.15% 门槛；FVG 已走动态门槛。
    if (!it.type.includes("FVG") && ((top - bottom) / top) * 100 < 0.15) continue;
    zones.push({
      type: it.type.includes("FVG") ? "FVG" : "OB",
      sourceType: it.type,
      direction: bias,
      top,
      bottom,
      mid: (top + bottom) / 2,
      // 固定长度历史窗口每轮会丢掉旧 K，数组 index 会漂移；时间才可用于跨轮询去重。
      id: it.id || `${it.type}_${it.time ?? it.index}_${String(bottom)}_${String(top)}`,
      quality: it.quality || null,
      executionStatus,
      widthPct: it.widthPct ?? null,
      widthAtr: it.widthAtr ?? null,
      // 来源字段（CHAIN 精确匹配 + 审计）：
      //   index — FVG：确认 K 索引；OB/Breaker：创建或激活该区域的结构位移 K 索引
      //   time — FVG：中间根开盘；OB：OB 所在 K 开盘
      //   displacement — 仅 OB 有意义（位移驱动生成）；FVG 无此字段 → false
      index: it.index,
      time: it.time,
      displacement: it.displacement === true,
      kind: it.kind ?? null,
      sourceObId: it.sourceObId ?? null,
      originRangeId: it.originRangeId ?? it.rangeId ?? null,
      tradingDayId: it.tradingDayId ?? null,
      displacementId: it.displacementId ?? null,
      structureEventId: it.structureEventId ?? null,
      age: it.age,
      status: it.status,
    });
  }
  // 按年龄升序（最近形成优先），过滤掉当前价已大幅偏离的区
  return zones.sort((a, b) => a.age - b.age);
}

/** RETRACE 合并高度重叠的同向 FVG；优先结构级、其次位移级，再取更新的区。CHAIN 保留原区精确匹配 MSS。 */
export function dedupeOverlappingFvgZones(zones, overlapThreshold = 0.8) {
  const rank = { STRUCTURE: 3, DISPLACEMENT: 2, RAW: 1 };
  const fvg = (zones || []).filter((z) => z.type === "FVG").sort((a, b) =>
    (rank[b.quality] || 0) - (rank[a.quality] || 0) || a.age - b.age);
  const kept = [];
  for (const zone of fvg) {
    const width = zone.top - zone.bottom;
    const duplicate = kept.some((other) => {
      const overlap = Math.max(0, Math.min(zone.top, other.top) - Math.max(zone.bottom, other.bottom));
      return overlap / Math.min(width, other.top - other.bottom) >= overlapThreshold;
    });
    if (!duplicate) kept.push(zone);
  }
  return [...(zones || []).filter((z) => z.type !== "FVG"), ...kept].sort((a, b) => a.age - b.age);
}

/** 信号 1 — 执行区回踩：价格正贴在/位于同向 FVG/OB 区间内（顺位端 = 入场参考） */
function detectRetrace({ ctx, bias, price, zones }) {
  zones = dedupeOverlappingFvgZones(zones);
  if (!zones.length) return null;
  let best = null;
  for (const z of zones) {
    // 当前价仍须位于执行区有效侧；确认后可以已经离开区间，不能再要求“此刻仍在区内”。
    const sideOk = bias === "BULLISH" ? price > z.bottom : price < z.top;
    if (!sideOk) continue;
    const confirmation = confirmExecutionZone({ ctx, zone: z, bias });
    if (!confirmation) continue;
    if (!best || confirmation.time > best.confirmation.time) best = { z, confirmation };
  }
  if (!best) return null;
  const z = best.z;
  const confirmation = best.confirmation;
  // executionStatus 区分 wick 穿越与收盘填平；不能把仍允许拒绝确认的 WICK_FILLED 写成“已填平”。
  const zoneState = z.executionStatus === "WICK_FILLED"
    ? "影线填平、收盘未填平"
    : z.executionStatus === "FILLED"
      ? "收盘填平"
      : z.executionStatus === "CE_REACHED"
        ? "已回补至中点"
        : z.executionStatus === "TOUCHED"
          ? "刚被触碰"
          : "未消耗";
  return {
    type: "RETRACE",
    direction: bias,
    entry: bias === "BULLISH" ? z.bottom : z.top,
    zone: { type: z.type, top: z.top, bottom: z.bottom, id: z.id, quality: z.quality, executionStatus: z.executionStatus },
    confirmation,
    trigger: `价格回踩 ${z.type} ${fmtNum(z.bottom)}-${fmtNum(z.top)}（${zoneState}）→ ${confirmation.text}`,
    // 同一执行区即同一机会；确认 K 每轮变化不应绕过 runMonitor 的 1h 冷却。
    key: `RETRACE_${bias}_${z.id}`,
    time: confirmation.time,
  };
}

/**
 * CHAIN 执行区必须与 MSS 位移腿精确对应——不允许用旧 FVG/OB 拼接虚假链条。
 * 索引语义对齐（同一已收盘 K 数组基准，见 computeM5Context）：
 *   FVG：zone.index = FVG 确认 K（findFvgs 的 i）须等于 mss.displacementConfirmationIndex
 *        （位移 FVG 的确认 K），且区间价格与 mss.displacementFvg 一致
 *   OB ：zone.displacement（位移驱动 OB）且 zone.index（= 推动该 OB 的位移 K）须等于
 *        mss.displacementIndex（MSS 位移 K）
 */
function linkedToMss(zone, mss) {
  if (zone.type === "FVG") {
    if (zone.index !== mss.displacementConfirmationIndex) return false;

    const fvg = mss.displacementFvg;
    if (!fvg) return false;

    return near(zone.top, fvg.top) && near(zone.bottom, fvg.bottom);
  }

  if (zone.type === "OB") {
    return zone.displacement === true && zone.index === mss.displacementIndex;
  }

  return false;
}

function near(a, b) {
  return Math.abs(a - b) / Math.max(Math.abs(b), 1e-9) < 0.000001;
}

/**
 * 信号 2 — 完整链条：扫损 → 5m MSS 转向 → 回踩同向执行区。
 * 只认顺 Bias 链：BULLISH 需 SSL 被扫（下方流动性扫掉 → 向上反转）→ MSS UP；
 * BEARISH 需 BSL 被扫 → MSS DOWN。sweep 由 biasMonitor 已计算（env.sweep）。
 * P1：MSS 突破腿必须为价格位移确认（大实体、单边收盘交付；成交量只作辅助证据）——
 * 低动能、贴线式结构转移不构成机构链条，否则 扫损→MSS→回踩 会频繁误报。
 * P1：CHAIN 执行区必须由该 MSS 位移腿产生（linkedToMss 按索引/价格精确匹配），
 * 普通 RETRACE 仍可用全部有效执行区，但高质量 CHAIN 不用旧 FVG/OB 拼凑。
 */
export function detectChain({ env, ctx, bias, price, zones }) {
  const expectedSide = bias === "BULLISH" ? "SSL" : "BSL";
  // CHAIN 只消费 biasMonitor 在事件形成轮冻结的正式 sequence。若该身份对象缺失，
  // 不能在机会扫描时用“当前 Range + 历史 ctx.events”事后重建一条更漂亮的链。
  const sequences = Array.isArray(env.liquiditySequences) ? env.liquiditySequences : [];
  const expectedRangeId = env.range?.rangeId ?? env.rangeLifecycle?.rangeId ?? null;
  const expectedTradingDayId = env.amd?.tradingDayId ?? null;
  const sequence = [...sequences]
    .filter((item) => item?.side === expectedSide
      && item.status === LIQUIDITY_SEQUENCE_STATUS.ICT_CONFIRMED
      && !!expectedRangeId && item.originRangeId === expectedRangeId
      && !!expectedTradingDayId && item.tradingDayId === expectedTradingDayId
      && item.id === env.amd?.liquiditySequenceId
      && item.firstMss?.confirmedByDisplacement
      && Number.isFinite(Number(item.confirmedAt))
      && marketNow() - Number(item.confirmedAt) <= SWEEP_WINDOW_MS)
    .sort((a, b) => Number(b.confirmedAt) - Number(a.confirmedAt))[0] || null;
  if (!sequence) return null;
  const sweep = sequence.primarySweep || sequence.sweeps?.at(-1) || env.sweep;
  const sweepTime = sequence.confirmedAt;
  const expectedMssDir = sequence.direction;
  const mss = sequence.firstMss;
  // 且价格已回踩该 MSS 位移腿产生的执行区，并出现新的 5m 入场确认
  if (!zones.length) return null;
  let matched = null;
  for (const zone of zones) {
    const notInvalidated = bias === "BULLISH" ? price > zone.bottom : price < zone.top;
    const exactSequenceFvg = sequence.confirmationFvg
      && zone.type === "FVG"
      && zone.id === sequence.confirmationFvg.id
      && near(zone.top, sequence.confirmationFvg.top)
      && near(zone.bottom, sequence.confirmationFvg.bottom)
      && (sequence.confirmationFvg.time == null || zone.time === sequence.confirmationFvg.time);
    if ((!linkedToMss(zone, mss) && !exactSequenceFvg) || !notInvalidated) continue;
    const confirmation = confirmExecutionZone({ ctx, zone, bias, afterTime: mss.time });
    if (confirmation) {
      matched = { zone, confirmation };
      break;
    }
  }
  if (!matched) return null;
  const { zone: z, confirmation } = matched;
  return {
    type: "CHAIN",
    direction: bias,
    entry: bias === "BULLISH" ? z.bottom : z.top,
    // 保留来源便于审计：哪个执行区、由哪条位移腿产生
    zone: { type: z.type, top: z.top, bottom: z.bottom, index: z.index, displacement: z.displacement, id: z.id, quality: z.quality, executionStatus: z.executionStatus },
    confirmation,
    mssIndex: mss.atIndex,
    liquiditySequenceId: sequence.id,
    sweepExtreme: sequence.sweptPrice,
    trigger: `扫损${sweep.side === "BSL" ? "BSL" : "SSL"} → 5m MSS（位移确认）${expectedMssDir === "UP" ? "向上" : "向下"} → 回踩 ${z.type} → ${confirmation.text}`,
    key: `CHAIN_${bias}_${z.id}_${sweep.key || sweepTime}`,
    time: confirmation.time,
  };
}

/**
 * P1-3：执行区只负责“观察”，入场机会必须由已收盘 5m 确认。
 * 确认方式：
 *   1) 触碰执行区后，同向实体收盘重新站回/跌回区间中点（CE）；或
 *   2) 触碰之后出现已确认的同向 MSS/BOS。
 */
function confirmExecutionZone({ ctx, zone, bias, afterTime = 0 }) {
  const candles = ctx.candles || [];
  if (!candles.length) return null;
  const first = Math.max((zone.index ?? -1) + 1, candles.length - CONFIRM_LOOKBACK);
  let touch = null;
  for (let i = first; i < candles.length; i++) {
    const k = candles[i];
    if ((k.closeTime ?? k.time) < afterTime) continue;
    if (k.low <= zone.top && k.high >= zone.bottom) {
      // V2.7：触碰深度要求——多头 K 须插到执行区中点及以下（low ≤ mid），空头须插到
      // 中点及以上（high ≥ mid）。浅插上沿（如 NBIS low 259.39 距 mid 259.305 还差 0.085）
      // 是插针不是回踩，不构成入场确认。
      const touchedMid = bias === "BULLISH" ? k.low <= zone.mid : k.high >= zone.mid;
      if (touchedMid) touch = { candle: k, index: i };
    }
  }
  if (!touch) return null;

  for (let i = touch.index; i < candles.length; i++) {
    const k = candles[i];
    const reclaimed = bias === "BULLISH"
      ? k.close >= zone.mid && k.close > k.open && k.close > zone.bottom
      : k.close <= zone.mid && k.close < k.open && k.close < zone.top;
    if (reclaimed) {
      return {
        type: "RECLAIM_CLOSE",
        time: k.closeTime ?? k.time,
        price: k.close,
        rejectionExtreme: bias === "BULLISH" ? touch.candle.low : touch.candle.high,
        text: `5m ${bias === "BULLISH" ? "收阳站回" : "收阴跌回"}执行区中点确认`,
      };
    }
  }

  const expected = bias === "BULLISH" ? "UP" : "DOWN";
  const touchTime = touch.candle.closeTime ?? touch.candle.time;
  const event = (ctx.events || []).find(
    (e) => e.confirmed && e.direction === expected && (e.type === "MSS" || e.type === "BOS") && e.time >= touchTime
  );
  if (!event) return null;
  return {
    type: "STRUCTURE_CONFIRMATION",
    eventType: event.type,
    time: event.time,
    price: event.price,
    rejectionExtreme: bias === "BULLISH" ? touch.candle.low : touch.candle.high,
    text: `5m ${event.type} ${expected} 结构确认`,
  };
}

/**
 * P1-2：真正可交易的 R 只在 5m 触发后计算。
 * 入场假设采用信号确认时现价；失效位采用本次 5m 执行区远端，完整 CHAIN 优先采用扫损极值。
 * 4H 深层保护位不再冒充订单止损。没有第一目标时仍返回止损计划，但交易 planR 为 null。
 */
function buildTradePlan(op, env) {
  const entry = Number(op.confirmation?.price ?? env.price);
  const sweptRaw = op.sweepExtreme ?? env.sweep?.sweptPrice;
  const swept = sweptRaw == null ? NaN : Number(sweptRaw);
  const localSweptRaw = op.localSweep?.sweptPrice;
  const localSwept = localSweptRaw == null ? NaN : Number(localSweptRaw);
  const useLocalSweep = op.type === "KEY_MSS" && Number.isFinite(localSwept);
  const useSweep = op.type === "CHAIN" && Number.isFinite(swept);
  const rejectionRaw = op.confirmation?.rejectionExtreme;
  const rejection = rejectionRaw == null ? NaN : Number(rejectionRaw);
  const useRejection = op.zone?.executionStatus === "WICK_FILLED" && Number.isFinite(rejection);
  const stop = useSweep
    ? swept
    : useLocalSweep
      ? localSwept
      : useRejection
        ? rejection
        : op.direction === "BULLISH"
          ? Number(op.zone?.bottom)
          : Number(op.zone?.top);
  if (!Number.isFinite(entry) || !Number.isFinite(stop)) return null;
  const risk = op.direction === "BULLISH" ? entry - stop : stop - entry;
  if (!(risk > 0)) return null;

  const targetRaw = env.targets?.first?.price;
  const target = targetRaw == null ? NaN : Number(targetRaw);
  const targetValid = Number.isFinite(target)
    && (op.direction === "BULLISH" ? target > entry : target < entry);
  return {
    entry,
    stop,
    stopSource: useSweep
      ? "SWEEP_EXTREME"
      : useLocalSweep
        ? "LOCAL_SWEEP_EXTREME"
        : useRejection
          ? "REJECTION_EXTREME"
          : "EXECUTION_ZONE",
    target: targetValid ? target : null,
    planR: targetValid ? Math.abs(target - entry) / risk : null,
  };
}

/** 评分（0-100）：环境分 + 信号类型权重。分越高越值得关注（推送门槛 OPP_MIN_SCORE）。 */
function scoreOpportunity(o, env) {
  let s = 0;
  // 环境（4H 层）
  if (env.confidence === "HIGH") s += 25;
  else if (env.confidence === "MEDIUM") s += 15;
  if (env.quality === "HIGH") s += 15;
  else if (env.quality === "MEDIUM") s += 8;
  if (env.ictSession) s += 10; // ICT 固定 Session；统计活跃成交量窗口不参与 ICT 共振评分
  if (env.structureStatus === "VALID") s += 5; // 4H 结构有效
  // 信号类型权重：完整链条 > 执行区回踩
  if (o.type === "CHAIN") s += 25;
  else if (o.type === "KEY_MSS") s += o.displacementConfirmed ? 25 : 20;
  else s += 10; // RETRACE
  if (o.zone) s += 5; // 有明确执行区（可挂单）
  if (o.zone?.quality === "STRUCTURE") s += 10;
  else if (o.zone?.quality === "DISPLACEMENT") s += 5;
  if (o.zone?.executionStatus === "WICK_FILLED") s -= 5;
  return Math.min(100, s);
}

/** 数字显示：按价格量级自适应，低价合约不能被压成 0.01-0.01。 */
function fmtNum(n) {
  if (n == null) return "-";
  const value = Number(n);
  if (!Number.isFinite(value)) return "-";
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 1 : abs >= 100 ? 2 : abs >= 1 ? 3 : abs >= 0.1 ? 4 : abs >= 0.01 ? 5 : 7;
  return String(Number(value.toFixed(digits)));
}

/** CLI：node monitor/opportunity.js SYMBOL（本地验证机会扫描输出） */
import { pathToFileURL } from "node:url";
import { getHistory } from "../data/binance.js";

const __isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (__isCli) {
  const symbol = process.argv[2];
  if (!symbol) {
    console.error("用法: node monitor/opportunity.js <SYMBOL>（如 MUUSDT）");
    process.exit(1);
  }
  const m5 = await getHistory(symbol, "5m", 1000);
  const price = m5[m5.length - 1].close;
  const env = { bias: process.argv[3] || "BULLISH", decision: "WATCH", price, confidence: "MEDIUM", quality: "HIGH", ictSession: { name: "NEW_YORK" }, structureStatus: "VALID", sweep: null };
  const opps = scanOpportunities({ symbol, env, m5 });
  const ctx = computeM5Context(m5, price);
  console.log(`${symbol} 现价 ${price} | 5m 结构 ${ctx.direction} | MSS/BOS 事件 ${ctx.events.length} | FVG ${ctx.pd.fvg.length} OB ${ctx.pd.ob.length}`);
  if (!opps.length) console.log("（无 ≥60 分机会）");
  for (const o of opps) {
    console.log(`[${o.score}] ${o.type} ${o.direction} entry=${o.entry}${o.zone ? ` zone=${o.zone.type} ${o.zone.bottom}-${o.zone.top}` : ""}`);
    console.log(`   ${o.trigger}`);
  }
}
