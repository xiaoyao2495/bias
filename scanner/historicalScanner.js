/**
 * historicalScanner.js — V2.2 Historical Bias Scanner
 *
 * 遍历历史（如 2025-01-01 ~ 2026-01-01），每隔 step 根 4H K 线取一个样本，
 * 在每个样本点用与 Case Replay 完全相同的流程跑 Daily Bias Engine，
 * 并对未来窗口（+7/+14/+30 根 4H）用 evaluator 判定 WIN / LOSS / NEUTRAL。
 *
 * 只做验证，不生成 Entry 信号；样本进入 Historical Bias Database 供 statistics 统计。
 *
 * 用法（经 scripts/scanBias.js CLI）：
 *   node scripts/scanBias.js BTCUSDT --start 2025-01-01 --end 2026-01-01 --step 6
 */
import { analyzeReplayPoint, loadReplayHistory, REPLAY_HISTORY_COUNTS } from "../engine/replayPipeline.js";
import { rebuildDealingRangeLifecycle } from "../indicators/dealingRangeLifecycle.js";
import { resolveInstrumentProfile } from "../indicators/instrumentProfile.js";
import { evaluateOutcome } from "./evaluator.js";

const DEFAULT_WINDOWS = [7, 14, 30];

/**
 * 扫描历史，生成样本库。
 *
 * @param {object} p
 * @param {string} p.symbol         如 "BTCUSDT"
 * @param {number} p.startTime      扫描起始（ms），取 openTime >= 该值的首个样本
 * @param {number} p.endTime        扫描结束（ms），样本及其未来窗口都在该时间之前
 * @param {number} [p.step=6]       每隔多少根 4H 取一个样本（6 ≈ 每天一个）
 * @param {number} [p.targetPct=0.05] 目标幅度（evaluator 用）
 * @param {number[]} [p.windows=[7,14,30]] 未来评估窗口（4H 根数）
 * @param {function} [p.onProgress] 进度回调（n, total, sample）
 * @returns {Promise<{ samples: Array, meta: Object }>}
 */
export async function scanHistory({ symbol, startTime, endTime, step = 6, targetPct = 0.05, windows = DEFAULT_WINDOWS, onProgress, exchangeInfo = null, instrumentProfile = null, history = null } = {}) {
  const loaded = history || await loadReplayHistory({
    symbol,
    earliestCutoff: startTime,
    exchangeInfo,
    instrumentProfile,
    h4Count: REPLAY_HISTORY_COUNTS.h4,
    dailyCount: REPLAY_HISTORY_COUNTS.daily,
    weeklyCount: REPLAY_HISTORY_COUNTS.weekly,
  });
  const h4 = loaded.h4 || [];
  const profile = instrumentProfile || loaded.instrumentProfile || resolveInstrumentProfile(symbol, exchangeInfo || loaded.exchangeInfo || {});

  // 样本及其未来窗口都限制在 endTime 之前
  const bars = h4.filter((k) => k.closeTime <= endTime);
  const maxW = Math.max(...windows);

  // 起始样本：openTime >= startTime 的第一根 K
  let startIdx = bars.findIndex((k) => k.time >= startTime);
  if (startIdx === -1) {
    throw new Error(`起始时间 ${new Date(startTime).toISOString()} 超出数据范围（4H 最早 ${bars.length ? new Date(bars[0].time).toISOString() : "-"}）`);
  }
  // 保证样本之后还有 maxW 根未来 K 用于评估
  const lastUsable = bars.length - maxW - 1;

  const indices = [];
  for (let i = startIdx; i <= lastUsable; i += step) indices.push(i);

  // Range 状态必须逐根推进，step 只控制“是否输出样本”，不能跳过中间的失效/MSS/位移。
  const lifecycle = rebuildDealingRangeLifecycle({
    candles: bars,
    endIndex: indices.length ? indices.at(-1) - 1 : -1,
  });
  const samples = [];
  for (let idx = 0; idx < indices.length; idx++) {
    const i = indices[idx];
    const k = bars[i];
    const { sample } = analyzeAt({
      symbol,
      history: { ...loaded, h4: bars },
      instrumentProfile: profile,
      exchangeInfo: exchangeInfo || loaded.exchangeInfo,
      bars,
      i,
      k,
      targetPct,
      windows,
      priorRange: i > 0 ? lifecycle.rangesByIndex[i - 1] || null : null,
    });
    samples.push(sample);
    if (onProgress) onProgress(idx + 1, indices.length, sample);
  }

  return {
    samples,
    meta: {
      symbol,
      startTime: new Date(bars[startIdx].time).toISOString(),
      endTime: new Date(bars[Math.min(bars.length - 1, indices[indices.length - 1] + maxW)]?.closeTime ?? endTime).toISOString(),
      step,
      targetPct,
      windows,
      sampleCount: samples.length,
      instrumentKind: profile?.kind || null,
      sessionModel: profile?.sessionModel || null,
      htfLiquiditySource: profile?.htfLiquiditySource || null,
      rangeLifecycleSteps: lifecycle.stepsProcessed,
      rangeTransitionCount: lifecycle.transitions.length,
    },
  };
}

/** 在 4H bars[i] 收盘点跑一次完整 Bias 分析 + 未来评估（与 Case Replay / 实时监控共用 analyzeBias） */
export function analyzeAt({ symbol, history, instrumentProfile, exchangeInfo, bars, i, k, targetPct, windows, priorRange = null }) {
  const t = k.closeTime;
  const point = analyzeReplayPoint({ symbol, cutoff: t, history, instrumentProfile, exchangeInfo, priorRange, rebuildRangeState: false });
  const { structure, liquidity, location, dealingRangeReady, rangeCandidate, ictSession, executionSession, bias } = point.result;
  const price = point.price;

  // P0-1：统一使用有效方向（effectiveBias）——MSS/保护位失效后 bias.bias 仍是失效前的
  // 原始方向，实盘展示用 effectiveBias（失效 → NEUTRAL），回测却按旧方向统计 WIN/LOSS，
  // 破坏"实时与回放一致"并污染 Confidence 的 LOW 组、总体胜率和 R。
  // 原始方向只保留为审计字段 rawBias。
  const effectiveBias = bias.effectiveBias || bias.bias;

  const future = bars.slice(i + 1, i + 1 + maxWindow(windows));
  const ev = evaluateOutcome({
    bias: effectiveBias,
    entry: price,
    invalidation: bias.invalidation ? bias.invalidation.price : null,
    drawPrice: bias.draw && bias.draw.primary ? bias.draw.primary.price : null,
    targetPct,
    futureCandles: future,
    windows,
  });

  return { sample: {
    time: new Date(t).toISOString().slice(0, 16).replace("T", " "),
    analysisTime: point.analysisTime,
    price,
    bias: effectiveBias,
    rawBias: bias.bias, // 审计：失效前原始结构方向（与实盘 effectiveBias 逻辑一致）
    structure: `${structure.direction}/${structure.type}`,
    scenario: bias.scenario ? bias.scenario.label : null,
    confidence: bias.confidence ? bias.confidence.level : null,
    confluenceScore: bias.confidence ? bias.confidence.confluenceScore : null,
    confidenceScore: bias.confidence ? bias.confidence.score : null, // 历史 schema 兼容
    confidenceFactors: bias.confidence ? bias.confidence.factors : null,
    execution: bias.executionState,
    location: location.location,
    context: location.context || null,
    rangeId: location?.rangeId || null,
    rangeVersion: location?.version || null,
    rangeStatus: location?.lifecycleStatus || null,
    rangeTransition: point.result.rangeTransition?.reason || null,
    dealingRangeReady,
    rangeCandidateType: rangeCandidate?.rangeType || null,
    instrumentKind: point.profile.kind,
    sessionModel: point.profile.sessionModel,
    htfLiquiditySource: liquidity.htfLiquiditySource,
    marketDayId: point.marketDayId,
    ictTradingDayId: point.ictTradingDayId,
    ictSession: ictSession?.name || null,
    executionSession: executionSession?.name || null,
    draw: bias.draw && bias.draw.primary ? { type: bias.draw.primary.type, price: bias.draw.primary.price } : null,
    invalidation: bias.invalidation ? bias.invalidation.price : null,
    futures: ev.futures,
    maxR: ev.maxR,
    planR: ev.planR, // V2.4：理论盈亏比（|Draw−Entry|/Risk）
    maePct: ev.maePct, // V2.4：最大逆行 %（路径质量）
    mfePct: ev.mfePct, // V2.4：最大顺行 %
  }, range: location?.rangeId ? location : null };
}

function maxWindow(windows) {
  return Math.max(...windows);
}
