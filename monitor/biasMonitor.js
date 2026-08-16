/**
 * biasMonitor.js — Monitor Step 2：对给定 symbol 列表跑 Daily Bias Engine
 *
 * 每个 symbol 用与 Historical Scanner 完全相同的流程：
 *   拉 4H/1D/1W 历史（已收盘 K）→ 结构/流动性/区间/PD Array/HTF 方向
 *   → computeDailyBias → 输出简洁摘要（Structure/Bias/Scenario/Confidence/Quality/Decision）
 *
 * 实时版没有未来窗口，Quality 用 4H 结构空间比（历史字段名 planR）分级代理：
 *   planR >= 1  → HIGH（空间充足）
 *   0.5 ~ 1     → MEDIUM（空间一般）
 *   < 0.5       → LOW（空间不足，接近目标）
 *   NEUTRAL/无 draw → "-"
 *
 * 决策简化为钉钉友好标签（保留原始值供 state 比较）：
 *   WATCH_FOR_ENTRY → WATCH（值得关注入场）
 *   WAIT_FOR_RETRACEMENT → WAIT（等回撤）
 *   NO_TRADE → NO TRADE
 *   WAIT → WAIT
 *
 * 用法（CLI 验证）：
 *   node monitor/biasMonitor.js BTCUSDT ETHUSDT SOLUSDT
 */
import { getHistory, getKlines } from "../data/binance.js";
import { classifyLiquidityEvent, detectSweepEvents } from "../indicators/sweep.js";
import { findDisplacements } from "../indicators/displacement.js";
import { scanStructureEvents } from "../indicators/mss.js";
import { buildLiquiditySequences, LIQUIDITY_SEQUENCE_POLICIES } from "../indicators/liquiditySequence.js";
import { buildSweepAudit } from "../indicators/sweepAudit.js";
import { computeAmdStage } from "../indicators/amd.js";
import { isLiquidityEventTimeForProfile, resolveInstrumentProfile, tradingDayIdAt } from "../indicators/instrumentProfile.js";
import { bindStructureEventsIdentity, sameCausalIdentity } from "../indicators/causalIdentity.js";
import { annotateFvgQuality, annotatePDArray, findFvgs, isIctValidFvg } from "../indicators/pdArray.js";
import { analyzeBias } from "../engine/analyzeBias.js";
import { buildReplayInput, REPLAY_HISTORY_COUNTS } from "../engine/replayPipeline.js";
import { pathToFileURL } from "node:url";
import { marketNow } from "../utils/marketClock.js";

// 与 scanner/replayCase 同款数据窗口：4H 5000 根 ≈ 830 天，1D/1W 供 HTF 方向
const SWEEP_WINDOW_MS = 48 * 5 * 60_000;

/** Draw 只认 ACTIVE；事件检测保留窗口内 SWEPT/BROKEN 位，以便轮询/重启后补报 L1/L2/L3。 */
export function isSweepCandidateAt(level, now, windowMs = SWEEP_WINDOW_MS) {
  return !level?.state
    || level.state === "ACTIVE"
    || (level.state === "SWEPT" && level.sweptAt >= now - windowMs)
    || (level.state === "BROKEN" && level.brokenAt >= now - windowMs);
}

/**
 * 对单个 symbol 跑一次 Bias 分析，返回简洁摘要。
 * @param {string} symbol 如 "BTCUSDT"
 * @param {Object} [opt]
 * @param {boolean} [opt.force4h] 跳过 4H 缓存强制拉取（4H 收盘边界轮用：保证收盘报告/结构检测用最新已收盘 K，见 M1）
 * @param {Object|null} [opt.priorRange] 上轮持久化的 ACTIVE Dealing Range
 * @returns {Promise<Object>} 摘要对象（字段见 analyzeSymbol 返回）
 */
export async function analyzeSymbol(symbol, { force4h = false, priorRange = null, exchangeInfo = {}, instrumentProfile = null } = {}) {
  const profile = instrumentProfile || resolveInstrumentProfile(symbol, exchangeInfo);
  // 股票关联标的需要从 5m 重建现金时段的上一日/周高低。3000 根约覆盖 10.4 天，
  // 足以跨普通周末保留上一完整交易周；Crypto 仍只需 1000 根做 Session/扫损。
  const m5History = profile.regularSession ? 3000 : 1000;
  const [h4, daily, weekly, m5, h1, h1Swing] = await Promise.all([
    getHistory(symbol, "4h", REPLAY_HISTORY_COUNTS.h4, { force: force4h }),
    getHistory(symbol, "1d", REPLAY_HISTORY_COUNTS.daily),
    getHistory(symbol, "1w", REPLAY_HISTORY_COUNTS.weekly),
    // 5m 同时用于 Session 区间、股票现金时段 PD/PW、流动性扫损和位移检测。
    getHistory(symbol, "5m", m5History).catch(() => []),
    // 1h 用于数据驱动活跃成交量窗口：只取上周一~五的 1h 成交量分布；
    // 缓存 TTL 一周；拉取失败降级为 []，不影响 ICT Session 独立标注。
    // fresh:false —— 周级缓存不追最近已收盘 K（binance.js 半成品剔除后不强制重拉），
    // 否则每根 1h 收盘都会触发一次 720 根重拉，破坏周 TTL 的陈旧语义。
    getKlines(symbol, "1h", 720, { fresh: false }).catch(() => []),
    // 1h 内部摆动流动性（internalHigh/Low）专用：48 根 ≈ 2 天，TTL 30 分钟。
    // 必须与成交量窗口的 1h（TTL 一周）分开——内部摆动是"最近 2-12 小时会被扫的位"，
    // 陈旧 1h 缓存会算出已被新高/新低取消的 swing（EDENUSDT 08/14 扫损消息根因：
    // 08:00 的 0.0828 在 09:00 收出 0.08686 后已不是 swing，旧缓存仍当内部高点）。
    getKlines(symbol, "1h", 48, { ttlMin: 30 }).catch(() => []),
  ]);

  if (!h4.length) throw new Error(`${symbol} 无 4H 数据`);
  const now = marketNow();
  // 统一 cutoff 构造器同时服务实盘与历史：结构只认已收盘 4H，价格只认已收盘 5m，
  // 日/周/Session/1H internal swing 均在同一 analysisTime 截断，禁止未来函数。
  const prepared = buildReplayInput({
    symbol,
    cutoff: now,
    history: { h4, daily, weekly, m5, h1, h1Swing },
    instrumentProfile: profile,
    priorRange,
  });
  const closed4h = prepared.input.candles;
  const lastClosed = closed4h.at(-1);
  const price4h = prepared.structurePrice;
  const time = prepared.structureTime;
  const price = prepared.price;
  const analysisTime = prepared.analysisTime;
  const price5m = m5.length ? m5[m5.length - 1].close : null; // 实时价：仅供 detectSweeps 实时扫损检测

  // 内部摆动流动性（1H 层最近 ACTIVE swing 高低点）：完美链条里被扫的"前低/前高"常属此类，
  // 此前不在扫损监控内（只有 PDH/PDL/EQH/盘前/外部位），普通前低被扫不报警，链条无法触发。
  // 不用 4H 摆动点：4H swing 距现价通常数天，48 根 5m 扫损窗口（≈4 小时）根本够不着；
  // 1H swing 距现价 2-12 小时，扫损窗口内可达，才是"扫下方流动性低点"里那个低点。
  // 取"最近 ACTIVE"（从近往远跳过 SWEPT/BROKEN）作为 Draw/riskLine；扫损检测会在下方另行
  // 加回窗口内最近 SWEPT 的位，避免事件在轮询间隔、重启或 1H/4H 收线边界被提前过滤。
  // 数据源用 h1Swing（48 根、TTL 30min，见上），不能用成交量窗口的周 TTL 1h 缓存——
  // 否则内部 swing 可能陈旧到已被更新高低点取消，导致扫过期的位。
  const internalHigh = prepared.internalLiquidity.activeHighLevel ? [prepared.internalLiquidity.activeHighLevel] : [];
  const internalLow = prepared.internalLiquidity.activeLowLevel ? [prepared.internalLiquidity.activeLowLevel] : [];
  const recentConsumedInternalHigh = prepared.internalLiquidity.recentConsumedHigh;
  const recentConsumedInternalLow = prepared.internalLiquidity.recentConsumedLow;

  // 核心判定链路（与 Historical Scanner 共用 analyzeBias，见 engine/analyzeBias.js）
  // 活跃成交量窗口按 analysisTime 精确命中；ICT Session 独立标注，不再借整根进行中 4H
  // 的未来覆盖范围提前生效。m5 同时用于美股关联标的的 04:00-09:30 ET 盘前流动性。
  const { structure, liquidity, location, dealingRangeReady, rangeCandidate, rangeTransition, pdArray, activeVolumeWindow, ictSession, executionSession, session, sessionRange, referenceSessionRange, htfContext, bias } = analyzeBias(prepared.input);
  // 用有效方向（结构失效 → NEUTRAL），避免显示"已过期的旧结构方向"误导；
  // 同时供扫损 Judas Swing 判定（方向与 bias 相反的 NY Open 扫损 = 开盘假动作）
  const effectiveBias = bias.effectiveBias || bias.bias;

  // P1-A：流动性扫损（5m K 线：进行中 5m 实时检测 + 最近 48 根已收盘 5m 确认，≈4 小时窗口）
  // 用 5m 粒度：扫损是分钟级价格行为（刺破流动性后收回），4H 单根 K 会把整个过程包住，粒度过粗
  const sweepCandidate = (x) => isSweepCandidateAt(x, now);
  // EXTERNAL_HIGH/LOW 已由 analyzeBias 按同一个 dealing range 注入 liquidity；structure 的
  // 历史祖先点不再重复加入并冒充 ERL。1H internal swing 仍补充日内 stop pools。
  const activeRangeId = dealingRangeReady ? location?.rangeId || null : null;
  const activeRangeFrom = location?.selectedAt ?? location?.confirmedAt ?? null;
  const eventTimeAllowed = (eventTime) => isLiquidityEventTimeForProfile(profile, eventTime);
  const attachRange = (level) => activeRangeId ? {
    ...level,
    rangeId: activeRangeId,
    rangeVersion: location?.version ?? null,
    rangeActiveFrom: activeRangeFrom,
    rangeClass: level.rangeClass || "IRL",
  } : level;
  const buyLevels = (liquidity.buySide || []).filter(sweepCandidate).concat(internalHigh, recentConsumedInternalHigh).map(attachRange);
  const sellLevels = (liquidity.sellSide || []).filter(sweepCandidate).concat(internalLow, recentConsumedInternalLow).map(attachRange);
  const sweeps = detectSweepEvents(m5, buyLevels, sellLevels, price5m, 48, effectiveBias, { eventTimeAllowed })
    .map((event) => ({
      ...event,
      tradingDayId: event.tradingDayId || tradingDayIdAt(event.closedTime ?? event.reclaimTime ?? event.time, profile),
    }));
  const closed5m = m5.filter((k) => k.closeTime <= now);
  const dispList = findDisplacements(m5);
  let liquiditySequences = [];
  let liquiditySequenceError = null;

  // P1-B：5m 层 MSS/BOS（周期无关检测；5m 用 ICT 最小 swing 窗口每侧 1 根，收盘确认）
  // 仅检测不生成信号：在扫损消息中标注（扫损→收回→MSS 是 ICT 经典链条），供人工判断结构转向。
  // m5 拉取失败（[]）时跳过，不阻断主分析。
  if (dealingRangeReady && sweeps.length && m5.length >= 3) {
    try {
      const events = bindStructureEventsIdentity(
        scanStructureEvents(m5, { lookback: 48, left: 1, right: 1 })
          .filter((event) => eventTimeAllowed(event.time)),
        {
          candles: closed5m,
          currentRange: location,
          priorRange,
          profile,
          timeframe: "5m",
          allowOriginLeg: false,
        },
      );
      const annotatedFvgs = annotatePDArray({ fvg: findFvgs(closed5m).slice(-80), ob: [] }, null, closed5m).fvg;
      const identifiedFvgs = annotateFvgQuality(annotatedFvgs, closed5m, {
        displacements: dispList,
        structureEvents: events,
        currentRange: location,
        priorRange,
        profile,
        timeframe: "5m",
      });
      const qualifiedFvgs = annotatePDArray(
        { fvg: identifiedFvgs, ob: [] },
        location,
        closed5m,
        { requireRangeIdentity: true },
      ).fvg;
      const causal = buildLiquiditySequences({
        sweeps,
        structureEvents: events,
        ...LIQUIDITY_SEQUENCE_POLICIES["5m"],
        confirmationZoneForMss: (event) => executableFvgForMss(qualifiedFvgs, event),
      });
      liquiditySequences = causal.sequences;
      for (const sweep of sweeps) {
        if (sweep.tier < 2) continue;
        const sequence = causal.bySweep.get(sweep) || null;
        const event = sequence?.firstMss || null;
        if (event) {
          sweep.mss5m = { direction: sweep.side === "SSL" ? "UP" : "DOWN", lastEvent: event };
          sweep.confirmationFvg = sequence.confirmationFvg;
          sweep.liquiditySequenceId = sequence.id;
        }
        Object.assign(sweep, classifyLiquidityEvent(sweep));
      }
    } catch (error) {
      liquiditySequenceError = {
        stage: "SWEEP_MSS_FVG_SEQUENCE",
        message: error instanceof Error ? error.message : String(error),
      };
      console.error(
        `[biasMonitor] ${symbol} 5m 因果链构建失败: ${liquiditySequenceError.message}`,
        error instanceof Error ? error.stack : error,
      );
    }
  }
  const sweep = sweeps.filter((item) => item.tier >= 2).at(-1) || null;
  const mss5m = sweep?.mss5m || null;
  const sweepAudit = buildSweepAudit({
    h5m: m5,
    buyLevels,
    sellLevels,
    sweeps,
    sequences: liquiditySequences,
    now,
    window: 48,
    rangeId: activeRangeId,
    dealingRangeReady,
    pipelineError: liquiditySequenceError,
    eventTimeAllowed,
  });

  // P1-C：位移 K（5m 粒度）：大实体 + 单边收盘交付；成交量是辅助证据而非课程硬门槛。
  // 收盘报告只能展示“刚收完的这根 4H”内部发生的 5m 位移，不能用滚动四小时窗口，
  // 否则边界附近会把上一根或新一根 4H 的位移拼到本根报告里。
  const displacement = displacementFor4h(dispList, lastClosed);

  const decision = bias.decision || {};
  const remotePlanR = decision.planR ?? null;
  // planR 的 Risk 用 riskLine（最近的 ACTIVE 失效线：1h swing > 4H MSS > 深层保护位，engine 算好）。
  // 不用深层保护位——它常距现价 10%+，planR 系统性偏低，产生"永远空间不足"的误读。
  const targets = buildTargetSummary(bias.draw, effectiveBias, price, bias.riskLine ?? (bias.structureProtection || bias.invalidation));
  // 对外的机会质量优先看价格会先遇到的流动性，而不是只看远端 HTF Draw。
  // 否则 SNDK 一类标的会因远端 PWH 显示 4R，但眼前 PDH 可能不足 0.2R。
  const planR = targets.first?.planR ?? remotePlanR;
  const quality = planR == null ? "-" : planR >= 1 ? "HIGH" : planR >= 0.5 ? "MEDIUM" : "LOW";

  // 最近仍有效的 ICT Order Block / Breaker。失效原 OB 只保留在审计数组，不进入通知或执行区。
  const obList = pdArray.ob || [];
  const ob = dealingRangeReady
    ? [...obList].reverse().find((item) => item.ict === true && item.executable !== false && item.status !== "INVALIDATED") || null
    : null;
  const obSummary = ob
    ? {
        id: ob.id,
        type: ob.type,
        direction: ob.direction,
        kind: ob.kind,
        state: ob.lifecycleState || ob.state,
        high: ob.high,
        low: ob.low,
        midpoint: ob.midpoint,
        status: ob.status,
        location: ob.location,
        structureEventType: ob.structureEventType,
        sourceObId: ob.sourceObId || null,
      }
    : null;
  // 4H 执行区供 5m“关键位置 MSS”判断：只传方向一致、仍有效的排名结果。
  // 5m 机会层只读取区间，不重新解释 4H PD Array。
  const rankedPdArray = bias.pdArray || { primary: null, alternatives: [] };
  const executionZones = [rankedPdArray.primary, ...(rankedPdArray.alternatives || [])]
    .filter((z) => z && z.top != null && z.bottom != null && z.status === "VALID")
    .map((z) => ({
      type: z.type,
      top: z.top,
      bottom: z.bottom,
      location: z.location,
      id: z.id || null,
      originRangeId: z.originRangeId || null,
      structureEventId: z.structureEventId || null,
      displacementId: z.displacementId || null,
    }));

  // activeVolumeWindow 是统计窗口；ictSession 是课程固定时段，两者不得混称。

  return {
    symbol,
    instrumentProfile: profile,
    htfLiquiditySource: liquidity.htfLiquiditySource,
    htfLiquidityComplete: liquidity.htfLiquidityComplete,
    referencePrices: liquidity.referencePrices || {},
    sessionRange,
    referenceSessionRange,
    analysisTime,
    time: new Date(time).toISOString().slice(0, 16).replace("T", " "),
    price,
    session,
    activeVolumeWindow,
    ictSession,
    executionSession,
    // 最后已收盘 4H（收盘报告用：收于开盘上方/下方）
    last4h: { open: lastClosed.open, close: lastClosed.close, openTime: lastClosed.time, time: lastClosed.closeTime },
    // 用有效方向（结构失效 → NEUTRAL），避免显示"已过期的旧结构方向"误导
    bias: effectiveBias,
    executionBias: bias.executionBias || effectiveBias,
    structureBias: bias.structureBias || bias.bias,
    narrativeBias: bias.narrativeBias || bias.bias,
    drawOnLiquidity: bias.drawOnLiquidity || null,
    narrativeContext: bias.narrativeContext || null,
    htfContext,
    provisionalStructureBreak: bias.provisionalStructureBreak || null,
    reversalEvidence: bias.reversalEvidence || null,
    structureStatus: bias.structureStatus,
    // 三层价格分工：MSS 确认位、4H 深层结构保护位、5m 机会止损（后者由 opportunity.js 生成）。
    mssInvalidation: bias.mssInvalidation || null,
    structureProtection: bias.structureProtection || bias.invalidation || null,
    invalidation: bias.structureProtection || bias.invalidation || null, // 兼容旧状态/报告：即深层结构保护位
    riskLine: bias.riskLine ?? null, // planR 用的最近失效线（1h ACTIVE swing > 4H MSS > 深层保护位）
    mss: bias.mss
      ? { ...bias.mss, time: new Date(time).toISOString().slice(0, 16).replace("T", " ") } // MSS 事件：方向/保护位/触发时间
      : null,
    scenario: bias.scenario ? bias.scenario.label : "-",
    confidence: bias.confidence ? bias.confidence.level : "-",
    confluenceScore: bias.confidence ? bias.confidence.confluenceScore : null,
    confidenceScore: bias.confidence ? bias.confidence.score : null, // 兼容旧 state/报告
    sweep, // { side, type, level, sweptPrice, close, time } | null（流动性扫损事件）
    sweeps, // 全部独立流动性池事件（按确认时间升序）；通知层逐条去重推送
    liquiditySequences, // 统一 Sweep→首条 MSS→位移/FVG 因果链；CHAIN 直接消费，不再另找 MSS
    sweepAudit, // 每轮解释为何停在 L0/L1/L2/L3；通知去重原因由 runMonitor 补充
    mss5m, // { direction, lastEvent } | null（5m 层最近 MSS/BOS 事件，扫损消息标注）
    displacement, // { time, direction, ratio, structureBreak, fvg } | null（位移 K，最近 4 小时内，三条件证据齐备）
    ob: obSummary, // 最近仍有效的结构级 OB / Breaker；失效对象不对外展示
    executionZones,
    quality,
    planR,
    remotePlanR,
    structureSpaceRatio: planR,
    remoteStructureSpaceRatio: remotePlanR,
    targets,
    decision: decision.decision || "-",
    decisionLabel: decisionLabel(decision.decision),
    reason: decision.reason || "-",
    execution: bias.executionState || "-",
    location: location.location,
    context: location.context || "-",
    rangePosition: location.position,
    dealingRangeReady,
    rangeObservation: !dealingRangeReady && rangeCandidate?.rangeType === "RECENT"
      ? { high: rangeCandidate.high, low: rangeCandidate.low, equilibrium: rangeCandidate.equilibrium, rangeType: "RECENT" }
      : null,
    // 推动区间（审计）：区间高低 + 起点/终点 swing 语义（ICT Impulse = Liquidity → Displacement → Expansion）
    range: dealingRangeReady
      ? { high: location.high, low: location.low, rangeType: location.rangeType, rangeId: location.rangeId || null, startReason: location.startReason || null, endReason: location.endReason || null }
      : null,
    // 持久化完整 ACTIVE Range；下一轮从 state 恢复，防滚动 swing/服务重启导致 ERL 身份漂移。
    rangeLifecycle: location?.rangeId ? location : null,
    rangeTransition,
    // AMD 阶段只验证同一交易日的因果顺序，不参与 Bias 生成：
    // 已完成 Session Range → raid → 位移 MSS → 同一位移 FVG。
    // UNSET 时返回 null → 消息层省略阶段行，不误标"积累"。
    amd: (() => {
      const amdStage = computeAmdStage({
        profile,
        sessionRange,
        sweeps,
        sweep,
        liquiditySequences,
        bias: effectiveBias,
        now: analysisTime,
      });
      return amdStage.stage === "UNSET" ? null : amdStage;
    })(),
  };
}

/**
 * Sweep → MSS 属于紧邻的因果链，不是“窗口内任意更晚 MSS”。
 * 60 分钟已覆盖 12 根 5m K；更久以后出现的结构转移不再归因给旧 sweep。
 */
export const SWEEP_MSS_LINK_WINDOW_MS = 60 * 60_000;

/** 只取 sweep 后首个、方向一致且仍在因果窗口内的已确认 MSS。 */
export function structureEventForSweep(events, sweep, maxDelayMs = SWEEP_MSS_LINK_WINDOW_MS) {
  if (!sweep) return null;
  const { bySweep } = buildLiquiditySequences({
    sweeps: [sweep],
    structureEvents: events,
    timeframeMs: 1,
    maxBars: maxDelayMs,
  });
  return bySweep.get(sweep)?.firstMss || null;
}

/**
 * 一次 MSS 只能确认它之前最近的一组同向 sweep。
 * 同一确认时刻的多个价位属于同一 raid leg，可共享该 MSS；相隔较远的旧 sweep 不得复用。
 */
export function linkStructureEventsToSweeps(events, sweeps, maxDelayMs = SWEEP_MSS_LINK_WINDOW_MS) {
  const causal = buildLiquiditySequences({
    sweeps,
    structureEvents: events,
    timeframeMs: 1,
    maxBars: maxDelayMs,
  });
  const links = new Map();
  for (const sweep of sweeps || []) {
    const event = causal.bySweep.get(sweep)?.firstMss;
    if (event) links.set(sweep, event);
  }
  return links;
}

/**
 * L3 只绑定本次位移 MSS 真正产生、且课程意义上仍有效的同一个 FVG。
 * ATR/tick 只影响后续交易区是否 executable，不能阻止 ICT 因果链完成。
 */
export function executableFvgForMss(fvgs, event) {
  if (!event?.confirmedByDisplacement || !event.displacementFvg) return null;
  const near = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-9) < 0.000001;
  return (fvgs || []).find((fvg) =>
    isIctValidFvg(fvg)
    && sameCausalIdentity(event, fvg, { requireDisplacement: true })
    && fvg.quality === "STRUCTURE"
    && fvg.index === event.displacementConfirmationIndex
    && near(fvg.top, event.displacementFvg.top)
    && near(fvg.bottom, event.displacementFvg.bottom)) || null;
}

/** 按价格行进顺序整理第一目标与远端 ICT Draw，并分别计算理论 R。 */
export function buildTargetSummary(draw, bias, price, invalidation) {
  const invalidationPrice = invalidation && typeof invalidation === "object" ? invalidation.price : invalidation;
  if (!draw || !draw.primary || price == null || invalidationPrice == null || (bias !== "BULLISH" && bias !== "BEARISH")) {
    return { first: null, remote: null };
  }
  const risk = bias === "BULLISH" ? price - invalidationPrice : invalidationPrice - price;
  if (!(risk > 0)) return { first: null, remote: null };

  const seen = new Set();
  const candidates = [draw.primary, ...(draw.alternatives || [])]
    .filter((t) => t && t.price != null)
    .filter((t) => (bias === "BULLISH" ? t.price > price : t.price < price))
    .filter((t) => {
      const key = `${t.type}_${t.price}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((t) => ({ type: t.type, price: t.price, planR: Math.abs(t.price - price) / risk }))
    .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price));

  const first = candidates[0] || null;
  const primary = candidates.find((t) => t.type === draw.primary.type && t.price === draw.primary.price) || null;
  const remote = primary && (!first || primary.type !== first.type || primary.price !== first.price) ? primary : null;
  return { first, remote };
}

/** 取指定已收盘 4H 内最后一次 5m 位移，并记录本根 4H 的位移总数。 */
export function displacementFor4h(displacements, candle) {
  if (!candle || candle.time == null || candle.closeTime == null) return null;
  const inCandle = (displacements || []).filter((d) => d.time >= candle.time && d.time <= candle.closeTime);
  const last = inCandle[inCandle.length - 1];
  const upCount = inCandle.filter((d) => d.direction === "UP").length;
  const downCount = inCandle.filter((d) => d.direction === "DOWN").length;
  return last
    ? {
        time: last.time,
        direction: last.direction,
        ratio: last.ratio,
        volumeRatio: last.volumeRatio, // 量/均量辅助证据；不作为课程硬门槛，无量数据为 null
        quality: last.quality || (last.ratio >= 2 ? "HIGH" : "MEDIUM"), // 透传位移质量（旧输入无 quality 时按 ratio 兜底）
        structureBreak: last.structureBreak,
        fvg: last.fvg,
        count: inCandle.length,
        upCount,
        downCount,
        dominantDirection: upCount === downCount ? "NEUTRAL" : upCount > downCount ? "UP" : "DOWN",
      }
    : null;
}

/** 对多个 symbol 串行分析（避免 Binance 限频），返回摘要数组 */
export async function analyzeSymbols(symbols, { onProgress, force4h = false, priorRanges = {}, exchangeInfo = {} } = {}) {
  const results = [];
  for (let i = 0; i < symbols.length; i++) {
    const s = symbols[i];
    try {
      results.push(await analyzeSymbol(s, { force4h, priorRange: priorRanges?.[s] || null, exchangeInfo }));
    } catch (e) {
      results.push({ symbol: s, error: e.message });
    }
    if (onProgress) onProgress(i + 1, symbols.length);
  }
  return results;
}

function decisionLabel(d) {
  return {
    WATCH_FOR_ENTRY: "WATCH",
    WAIT_FOR_RETRACEMENT: "WAIT",
    NO_TRADE: "NO TRADE",
    WAIT: "WAIT",
  }[d] || d || "-";
}

/** CLI：node monitor/biasMonitor.js BTCUSDT ETHUSDT SOLUSDT */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const symbols = process.argv.slice(2);
  if (!symbols.length) {
    console.error("用法: node monitor/biasMonitor.js <SYMBOL>... （如 BTCUSDT ETHUSDT SOLUSDT）");
    process.exit(1);
  }
  const icon = { BULLISH: "🟢", BEARISH: "🔴", NEUTRAL: "⚪" };
  analyzeSymbols(symbols, { onProgress: (n, t) => console.error(`[monitor] ${n}/${t}`) })
    .then((list) => {
      for (const r of list) {
        if (r.error) {
          console.log(`${r.symbol}\n  ERROR: ${r.error}\n`);
          continue;
        }
        console.log(`${r.symbol}  ${r.price}`);
        console.log(`Bias: ${icon[r.bias] || ""} ${r.bias}`);
        console.log(`活跃成交量: ${r.activeVolumeWindow ? `窗口 ${String(r.activeVolumeWindow.start).padStart(2, "0")}:00-${String(r.activeVolumeWindow.end).padStart(2, "0")}:00（占比 ${r.activeVolumeWindow.ratio}%）` : "当前不在统计活跃窗口"}`);
        console.log(`ICT Session: ${r.ictSession ? r.ictSession.label : "当前不在 Killzone"}`);
        console.log(`Scenario: ${r.scenario}`);
        console.log(`模型信心: ${r.confidence}${r.confluenceScore != null ? ` · 共振评分 ${r.confluenceScore}` : ""}`);
        console.log(`机会质量: ${r.quality}${r.planR != null ? ` (planR ${r.planR.toFixed(2)})` : ""}`);
        console.log(`操作: ${r.decisionLabel}`);
        console.log(`原因: ${r.reason}`);
        if (r.ob) console.log(`最近OB: ${r.ob.type}（${r.ob.kind} · ${r.ob.state}${r.ob.status ? ` · ${r.ob.status}` : ""}）`);
        console.log(`Execution: ${r.execution} @ ${r.location}/${r.context}\n`);
      }
    })
    .catch((e) => {
      console.error(`[monitor] 失败: ${e.message}`);
      process.exit(1);
    });
}
