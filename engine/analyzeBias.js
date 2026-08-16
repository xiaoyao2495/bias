/**
 * analyzeBias.js — 共用 Bias 分析函数（biasMonitor 实时监控 与 historicalScanner 回放 共用）
 *
 * 组合指标层（swing / structure / liquidity / dealingRange / pdArray / scenario）+ engine，
 * 消除两处"拉数据 → 结构 → Bias"链路的重复实现（审计 m3）。
 *
 * 行为约定（保证 实时 与 回放 完全一致）：
 *   - 内部统一按 time 截断日/周线：computeHtfDirection 要求调用方预截断，
 *     实时模式若传完整日线会用"进行中的最新日 K"（未定型），与回放不一致；
 *     统一截断后 HTF 方向只认已收盘日/周 K，实时性由 price（4H 收盘价）的 BOS 修正注入。
 *   - computeLiquidity 自身按 now 过滤（lastCompleted），传截断数组幂等安全。
 */
import { findSwings, analyzeSwings } from "../indicators/swing.js";
import { buildStructure } from "../indicators/structure.js";
import { applyDealingRangeLiquidity, computeLiquidity, liquidityStateForLevel } from "../indicators/liquidity.js";
import { computeDealingRange, isActiveDealingRange } from "../indicators/dealingRange.js";
import { resolveDealingRangeLifecycle } from "../indicators/dealingRangeLifecycle.js";
import { annotateFvgQuality, findFvgs, findOrderBlocks, annotatePDArray, isIctValidFvg } from "../indicators/pdArray.js";
import { findDisplacements } from "../indicators/displacement.js";
import { computeHtfContext } from "../indicators/scenario.js";
import { lastTradingWeek, computeActiveWindows, activeVolumeWindowAt, ictSessionAt } from "../indicators/killzone.js";
import { scanStructureEvents } from "../indicators/mss.js";
import { buildLiquiditySequences, LIQUIDITY_SEQUENCE_POLICIES } from "../indicators/liquiditySequence.js";
import { isExecutionSessionForProfile, tradingDayIdAt } from "../indicators/instrumentProfile.js";
import { bindStructureEventsIdentity, causalRangeId, rangeForEvent, sameCausalIdentity } from "../indicators/causalIdentity.js";
import { computeDailyBias } from "./dailyBiasEngine.js";

export const HTF_REVERSAL_MAX_BARS = LIQUIDITY_SEQUENCE_POLICIES["4h"].maxBars;

/**
 * @param {Object} p
 * @param {Array}  p.candles  4H K 线（已按分析时刻截断，末根为当前判定基准）
 * @param {Array}  p.daily    日线 K 线（可传完整历史，内部按 time 截断）
 * @param {Array}  p.weekly   周线 K 线（可传完整历史，内部按 time 截断）
 * @param {number} p.price    执行参考价（实盘=最近已收盘 5m；回放=4H 收盘）
 * @param {number} [p.structurePrice] 4H 结构确认价（必须是已收盘 4H close）；不传则回退 price
 * @param {number} p.time     分析时刻（ms，取 closeTime <= time 的已收盘日/周 K；回放 = 4H 收盘点）
 * @param {number} [p.analysisTime] 实时模式的流动性截断时刻（ms）＝当前最近已收盘 5m 的 closeTime。
 *                            日/周/盘前流动性与活跃窗口用它截断；不传（回放/审计）→ 回退 time。
 * @param {Array}  [p.h1]     1h K 线（可选，上周交易周成交量 → 数据驱动活跃窗口）。
 *                            传入后计算 activeVolumeWindow；不传则该统计因子为空。
 * @param {number} [p.pdArrayLimit=6] PD Array（FVG/OB）截取数量
 * @param {Array}  [p.m5]     5m K 线（可选，仅美股关联标的用于精确计算盘前 04:00-09:30 ET）。
 * @param {{low:number|null, high:number|null}} [p.internalSwing] 1h 最近 ACTIVE swing 高低点（实盘由 biasMonitor 注入，
 *                            用于 planR 的最近失效线 riskLine；不传则回退 4H MSS/深层保护位）。
 * @param {string} [p.symbol] 合约代码。
 * @param {Object} [p.instrumentProfile] 统一市场画像；决定 Session 流动性与执行时段，不改变价格行为定义。
 * @returns {{ structure, liquidity, location, pdArray, htfDirection, htfContext, activeVolumeWindow, ictSession, session, bias }}
 */
export function analyzeBias({ candles, daily, weekly, price, structurePrice, time, analysisTime, h1, m5, symbol, instrumentProfile, internalSwing, priorRange = null, pdArrayLimit = 6 }) {
  // P1：日/周/盘前流动性截断时刻与结构参考时刻拆分——结构只用已收盘 4H（candles），
  // 流动性截断用 analysisTime（实时 = 最近已收盘 5m 的 closeTime），回放回退 time（4H 收盘点）。
  const cutoff = analysisTime ?? time;
  const day = daily.filter((c) => c.closeTime <= cutoff);
  const week = weekly.filter((c) => c.closeTime <= cutoff);

  const swings = findSwings(candles);
  const labeled = analyzeSwings(swings);
  const structure = buildStructure(labeled);
  let liquidity = computeLiquidity(day, week, swings, null, cutoff, 150, m5, candles, { symbol, profile: instrumentProfile });
  const resolvedInstrumentProfile = liquidity.instrumentProfile || instrumentProfile || null;
  annotateStructureLiquidityStates(structure, candles);
  const displacements4h = findDisplacements(candles);
  const structureEvents4h = scanStructureEvents(candles, { lookback: 50, left: 2, right: 2 });
  const rangeCandidate = computeDealingRange(swings, structure, price, liquidity);
  const { range: lifecycleRange, transition: rangeTransition } = resolveDealingRangeLifecycle({
    candidate: rangeCandidate,
    prior: priorRange,
    candles,
    structureEvents: structureEvents4h,
    price,
    confirmedClose: candles.at(-1)?.close,
    selectedAt: cutoff,
  });
  const dealingRangeReady = isActiveDealingRange(lifecycleRange);
  // OBSERVATION / INVALIDATED 区间可以保留端点供审计，但不能提供交易位置。
  const location = dealingRangeReady ? lifecycleRange : lifecycleRange ? {
    ...lifecycleRange,
    location: "UNKNOWN",
    context: "UNKNOWN",
    position: null,
    tradable: false,
  } : lifecycleRange;
  const activeRange = dealingRangeReady ? location : null;
  const fvgs = findFvgs(candles);
  const rangedStructureEvents4h = bindStructureEventsIdentity(structureEvents4h, {
    candles,
    currentRange: activeRange,
    priorRange,
    profile: resolvedInstrumentProfile,
    timeframe: "4h",
    allowOriginLeg: true,
  });
  const obs = findOrderBlocks(candles, {
    displacements: displacements4h,
    structureEvents: rangedStructureEvents4h,
  });
  // 反转证据不能只看“展示用最后6个 FVG”，否则高波动阶段相关位移 FVG 会因切片被漏掉。
  const allAnnotatedFvgs = annotatePDArray({ fvg: fvgs, ob: [] }, activeRange, candles).fvg;
  const identifiedFvgs = annotateFvgQuality(allAnnotatedFvgs, candles, {
    displacements: displacements4h,
    structureEvents: rangedStructureEvents4h,
    currentRange: activeRange,
    priorRange,
    profile: resolvedInstrumentProfile,
    timeframe: "4h",
  });
  const allQualifiedFvgs = annotatePDArray(
    { fvg: identifiedFvgs, ob: [] },
    activeRange,
    candles,
    { requireRangeIdentity: true },
  ).fvg;
  // pdArray 是执行视图：先过滤失效原 OB，再截取最近区域，避免大量历史 INVALIDATED
  // 对象占满 limit 后把稍早但仍有效的 OB/Breaker 挤出。完整审计仍可直接调用 findOrderBlocks。
  const activeFvgs = allQualifiedFvgs.filter((item) => item.executable === true && causalRangeId(item) === activeRange?.rangeId);
  const activeObs = obs.filter((item) => item.executable === true && causalRangeId(item) === activeRange?.rangeId);
  const annotatedObs = annotatePDArray(
    { fvg: [], ob: activeObs.slice(-pdArrayLimit) },
    activeRange,
    candles,
    { requireRangeIdentity: true },
  ).ob;
  const pdArray = { fvg: activeFvgs.slice(-pdArrayLimit), ob: annotatedObs.filter((item) => item.executable === true) };
  liquidity = applyDealingRangeLiquidity({ liquidity, range: activeRange, swings, fvgs: activeFvgs.slice(-80), candles, price });
  const htfContext = computeHtfContext(day, week, price);
  const htfDirection = htfContext.confirmedDirection;
  const reversalEvidence = findReversalEvidence(candles, structure, liquidity, rangedStructureEvents4h, allQualifiedFvgs, {
    currentRange: activeRange,
    priorRange,
    profile: resolvedInstrumentProfile,
  });
  // 数据驱动活跃窗口只按“当前分析时刻”命中，不能拿整根进行中 4H 的覆盖范围判断，
  // 否则 20:10 会因该 K 将在 21:00 覆盖活跃窗口而提前获得评分。
  let activeVolumeWindow = null;
  if (h1 && h1.length) {
    const wk = lastTradingWeek(h1, cutoff);
    if (wk.length >= 24) {
      activeVolumeWindow = activeVolumeWindowAt(cutoff, computeActiveWindows(wk));
    }
  }
  const ictSession = ictSessionAt(cutoff);
  const resolvedProfile = resolvedInstrumentProfile;
  const executionSession = isExecutionSessionForProfile(resolvedProfile, ictSession, cutoff) ? ictSession : null;
  const session = activeVolumeWindow; // 兼容旧 state/消息；新代码应读取 activeVolumeWindow
  const bias = computeDailyBias({
    structure,
    liquidity,
    location,
    price,
    structurePrice: structurePrice ?? price,
    pdArray,
    htfDirection,
    htfContext,
    reversalEvidence,
    structureEvents: rangedStructureEvents4h,
    ictSession: executionSession,
    internalSwing,
  });

  return {
    structure,
    liquidity,
    location,
    dealingRangeReady,
    rangeCandidate,
    rangeTransition,
    pdArray,
    structureEvents4h: rangedStructureEvents4h,
    htfDirection,
    htfContext,
    activeVolumeWindow,
    ictSession,
    executionSession,
    session,
    instrumentProfile: resolvedProfile,
    sessionRange: liquidity.sessionRange || null,
    referenceSessionRange: liquidity.referenceSessionRange || null,
    bias,
  };
}

export function annotateStructureLiquidityStates(structure, candles) {
  const closeAt = (index, time) => {
    const k = index != null ? candles[index] : null;
    return k ? k.closeTime ?? k.time : time;
  };
  // findSwings 的 4H pivot 需要右侧 2 根 K 确认；确认前的价格行为不能反过来“扫掉”尚未成立的流动性。
  const confirmedCloseAt = (index, time) => closeAt(index != null ? index + 2 : index, time);
  if (structure.externalSwingHigh != null) {
    structure.externalSwingHighState = liquidityStateForLevel(
      { price: structure.externalSwingHigh },
      true,
      candles,
      confirmedCloseAt(structure.externalSwingHighIndex, structure.externalSwingHighTime)
    );
  }
  if (structure.externalSwingLow != null) {
    structure.externalSwingLowState = liquidityStateForLevel(
      { price: structure.externalSwingLow },
      false,
      candles,
      confirmedCloseAt(structure.externalSwingLowIndex, structure.externalSwingLowTime)
    );
  }
  if (structure.lastHigh) {
    structure.lastHighState = liquidityStateForLevel(
      { price: structure.lastHigh.price },
      true,
      candles,
      confirmedCloseAt(structure.lastHigh.index, structure.lastHigh.time)
    );
  }
  if (structure.lastLow) {
    structure.lastLowState = liquidityStateForLevel(
      { price: structure.lastLow.price },
      false,
      candles,
      confirmedCloseAt(structure.lastLow.index, structure.lastLow.time)
    );
  }
}

/** HTF 冲突时，只有“反向流动性已扫 + 4H 位移 MSS”才确认反转 Narrative。 */
export function findReversalEvidence(candles, structure, liquidity, structureEvents = null, fvgs = [], identityContext = {}) {
  const direction = structure.direction;
  if (direction !== "BULLISH" && direction !== "BEARISH") return { confirmed: false, sweep: null, mss: null };
  const levels = direction === "BULLISH" ? [...(liquidity.sellSide || [])] : [...(liquidity.buySide || [])];
  const events = structureEvents || scanStructureEvents(candles, { lookback: 50, left: 2, right: 2 });
  return reversalEvidenceFromEvents(events, direction, levels, HTF_REVERSAL_MAX_BARS, fvgs, identityContext);
}

/**
 * 4H 反转证据使用与 5m L3/CHAIN 相同的 raid→首条 MSS 匹配算法；仅周期策略不同。
 * 3 根 4H 是当前工程初值（12 小时），不是冒充 ICT 课程中的固定数字。
 */
export function reversalEvidenceFromEvents(events, direction, levels, maxBars = HTF_REVERSAL_MAX_BARS, fvgs = [], identityContext = {}) {
  if (direction !== "BULLISH" && direction !== "BEARISH") return { confirmed: false, sweep: null, mss: null };
  const side = direction === "BULLISH" ? "SSL" : "BSL";
  const raids = (levels || [])
    .filter((level) => level?.state === "SWEPT" && Number.isFinite(Number(level.sweptAt)))
    .map((level) => {
      const sweptAt = Number(level.sweptAt);
      const range = rangeForEvent({ time: sweptAt, originRangeId: level.originRangeId ?? null }, {
        currentRange: identityContext.currentRange,
        priorRange: identityContext.priorRange,
        allowOriginLeg: true,
      });
      const originRangeId = level.originRangeId || range?.rangeId || null;
      return ({
      tier: 2,
      side,
      time: sweptAt,
      closedTime: sweptAt,
      key: `HTF_${side}_${level.type || "LEVEL"}_${level.price ?? "-"}_${level.sweptAt}`,
      sourceLevel: level,
      originRangeId,
      rangeId: originRangeId,
      tradingDayId: level.sweepTradingDayId ?? tradingDayIdAt(sweptAt, identityContext.profile),
    });
    });
  if (!raids.length) return { confirmed: false, sweep: null, mss: null };

  const { sequences } = buildLiquiditySequences({
    sweeps: raids,
    structureEvents: events,
    timeframeMs: LIQUIDITY_SEQUENCE_POLICIES["4h"].timeframeMs,
    maxBars,
    confirmationZoneForMss: (event) => ictFvgForStructureEvent(fvgs, event),
  });
  const sequence = sequences
    .filter((item) => item.status === "ICT_CONFIRMED")
    .sort((a, b) => b.confirmedAt - a.confirmedAt)[0] || null;
  if (!sequence) {
    const latest = [...raids].sort((a, b) => b.closedTime - a.closedTime)[0];
    return { confirmed: false, sweep: latest?.sourceLevel || null, mss: null };
  }
  return {
    confirmed: true,
    sweep: sequence.primarySweep?.sourceLevel || null,
    mss: sequence.firstMss,
    fvg: sequence.confirmationFvg,
    liquiditySequenceId: sequence.id,
  };
}

function ictFvgForStructureEvent(fvgs, event) {
  if (!event?.confirmedByDisplacement || !event.displacementFvg) return null;
  const near = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-9) < 0.000001;
  return (fvgs || []).find((fvg) => isIctValidFvg(fvg)
    && sameCausalIdentity(event, fvg, { requireDisplacement: true })
    && fvg.quality === "STRUCTURE"
    && fvg.index === event.displacementConfirmationIndex
    && near(fvg.top, event.displacementFvg.top)
    && near(fvg.bottom, event.displacementFvg.bottom)) || null;
}
