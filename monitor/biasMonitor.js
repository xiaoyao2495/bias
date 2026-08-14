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
import { detectSweeps } from "../indicators/sweep.js";
import { findDisplacements } from "../indicators/displacement.js";
import { detectStructureEvents } from "../indicators/mss.js";
import { computeAmdStage } from "../indicators/amd.js";
import { findSwings, analyzeSwings } from "../indicators/swing.js";
import { liquidityStateForLevel } from "../indicators/liquidity.js";
import { analyzeBias } from "../engine/analyzeBias.js";
import { pathToFileURL } from "node:url";

// 与 scanner/replayCase 同款数据窗口：4H 5000 根 ≈ 830 天，1D/1W 供 HTF 方向
const HISTORY = { "4h": 5000, "1d": 2000, "1w": 400 };

/**
 * 对单个 symbol 跑一次 Bias 分析，返回简洁摘要。
 * @param {string} symbol 如 "BTCUSDT"
 * @param {Object} [opt]
 * @param {boolean} [opt.force4h] 跳过 4H 缓存强制拉取（4H 收盘边界轮用：保证收盘报告/结构检测用最新已收盘 K，见 M1）
 * @returns {Promise<Object>} 摘要对象（字段见 analyzeSymbol 返回）
 */
export async function analyzeSymbol(symbol, { force4h = false } = {}) {
  const [h4, daily, weekly, m5, h1, h1Swing] = await Promise.all([
    getHistory(symbol, "4h", HISTORY["4h"], { force: force4h }),
    getHistory(symbol, "1d", HISTORY["1d"]),
    getHistory(symbol, "1w", HISTORY["1w"]),
    // 5m 同时用于盘前区间、流动性扫损和位移检测。1000 根覆盖约 3.5 天，
    // 可跨周末保留最近完整盘前；与机会扫描共用同一份缓存。拉取失败降级为 []。
    getHistory(symbol, "5m", 1000).catch(() => []),
    // 1h 用于数据驱动活跃成交量窗口：只取上周一~五的 1h 成交量分布；
    // 缓存 TTL 一周；拉取失败降级为 []，不影响 ICT Session 独立标注。
    getKlines(symbol, "1h", 720).catch(() => []),
    // 1h 内部摆动流动性（internalHigh/Low）专用：48 根 ≈ 2 天，TTL 30 分钟。
    // 必须与成交量窗口的 1h（TTL 一周）分开——内部摆动是"最近 2-12 小时会被扫的位"，
    // 陈旧 1h 缓存会算出已被新高/新低取消的 swing（EDENUSDT 08/14 扫损消息根因：
    // 08:00 的 0.0828 在 09:00 收出 0.08686 后已不是 swing，旧缓存仍当内部高点）。
    getKlines(symbol, "1h", 48, { ttlMin: 30 }).catch(() => []),
  ]);

  if (!h4.length) throw new Error(`${symbol} 无 4H 数据`);
  // P0-3：结构/Dealing Range/4H FVG/OB 一律只用已收盘 4H。getHistory 返回的末根通常是
  // 进行中的 Binance 4H K：未收盘 K 可改变倒数 swing 的右侧确认、提前生成/撤销 FVG/OB，
  // 且其 closeTime 是未来时间——实盘结果会在 4H 内重绘，而 Historical Scanner 只用已收盘 K，
  // 造成"实时与回放不一致"。实时 5m 价格仍作为独立 provisional 事件（price）输入，不参与 4H 结构定型。
  const now = Date.now();
  const closed4h = h4.filter((k) => k.closeTime <= now);
  const lastK = closed4h[closed4h.length - 1] || h4[h4.length - 1]; // 兜底：理论上总有已收盘 K
  const lastClosed = lastK; // 最后已收盘 4H（收盘报告用：收于开盘上方/下方）
  const price4h = lastK.close; // 4H 末根收盘价（缓存下最多陈旧 4 小时）
  const time = lastK.closeTime;
  // 核心判定与展示用"收盘确认价"：最近一根已收盘 5m 的 close（5m TTL 5 分钟 + 最多跳过 1 根未收盘 5m，
  // 判定价最多滞后 ~10 分钟）。审计修复：原实现用进行中 5m 的实时 close 判 4H 结构失效/MSS/confidence/planR，
  // 实时插针（瞬时跌破保护位又收回）会在 10 分钟轮内触发结构 INVALIDATED → Bias 翻转刷屏；
  // 收盘确认价与 mss.js"事件需收盘确认"的语义保持一致。5m 拉取失败/无已收盘 5m → 回退 4H 收盘价。
  const price5m = m5.length ? m5[m5.length - 1].close : null; // 实时价：仅供 detectSweeps 实时扫损检测
  // P1：analysisTime = 当前最近已收盘 5m 的 closeTime（日/周/盘前流动性截断用）。
  // 若仍用最后已收盘 4H 的结束时间（time），21:30 时盘前区间只统计到 20:00，
  // 已收盘的 20:00–21:00 1H K 会被遗漏；5m 粒度只滞后 ≤5 分钟。
  let price;
  let analysisTime = time;
  if (m5.length) {
    const last5m = m5[m5.length - 1];
    if (last5m.closeTime <= Date.now()) {
      price = last5m.close;
      analysisTime = last5m.closeTime;
    } else if (m5[m5.length - 2]) {
      price = m5[m5.length - 2].close;
      analysisTime = m5[m5.length - 2].closeTime;
    } else {
      price = price4h;
    }
  } else {
    price = price4h;
  }

  // 内部摆动流动性（1H 层最近 ACTIVE swing 高低点）：完美链条里被扫的"前低/前高"常属此类，
  // 此前不在扫损监控内（只有 PDH/PDL/EQH/盘前/外部位），普通前低被扫不报警，链条无法触发。
  // 不用 4H 摆动点：4H swing 距现价通常数天，48 根 5m 扫损窗口（≈4 小时）根本够不着；
  // 1H swing 距现价 2-12 小时，扫损窗口内可达，才是"扫下方流动性低点"里那个低点。
  // 取"最近 ACTIVE"（从近往远跳过 SWEPT/BROKEN）：SWEPT 的位已被消耗，既不该监控扫损，
  // 也不该作为 riskLine 止损参考（MU/SOXL 08/14 最近 1h swing low 均被扫，需回退到次近 ACTIVE）。
  // 数据源用 h1Swing（48 根、TTL 30min，见上），不能用成交量窗口的周 TTL 1h 缓存——
  // 否则内部 swing 可能陈旧到已被更新高低点取消，导致扫过期的位。
  const closed1h = h1Swing.filter((k) => k.closeTime <= now);
  const swings1h = analyzeSwings(findSwings(closed1h, 1, 1));
  const isActive1h = (s, isBuy) => liquidityStateForLevel({ price: s.price }, isBuy, closed1h, closed1h[s.index].closeTime).state === "ACTIVE";
  // 位必须与现价同侧：BEARISH 的 internalHigh 须仍在价格上方（价格未突破它），BULLISH 的
  // internalLow 须仍在价格下方。价格已突破的位（如 BZUSDT 08/14 22:50 现价 85.84 > 1h swing high
  // 85.76）既不能当失效线（risk = 位-现价 变负 → 目标/planR 全失效 →"机会质量 -"），
  // 也不该再监控扫损（流动性已被价格吃掉）。从近往远回退到满足同侧条件的次近 ACTIVE swing。
  const lastActiveHigh1h = swings1h.filter((s) => s.type === "HIGH").reverse().find((s) => isActive1h(s, true) && (price == null || s.price > price));
  const lastActiveLow1h = swings1h.filter((s) => s.type === "LOW").reverse().find((s) => isActive1h(s, false) && (price == null || s.price < price));
  const internalHigh = lastActiveHigh1h
    ? [{ type: "INTERNAL_HIGH", price: lastActiveHigh1h.price, state: "ACTIVE", ...(lastActiveHigh1h.time != null ? { time: lastActiveHigh1h.time } : {}) }]
    : [];
  const internalLow = lastActiveLow1h
    ? [{ type: "INTERNAL_LOW", price: lastActiveLow1h.price, state: "ACTIVE", ...(lastActiveLow1h.time != null ? { time: lastActiveLow1h.time } : {}) }]
    : [];

  // 核心判定链路（与 Historical Scanner 共用 analyzeBias，见 engine/analyzeBias.js）
  // 活跃成交量窗口按 analysisTime 精确命中；ICT Session 独立标注，不再借整根进行中 4H
  // 的未来覆盖范围提前生效。m5 同时用于美股关联标的的 04:00-09:30 ET 盘前流动性。
  const { structure, liquidity, location, pdArray, activeVolumeWindow, ictSession, session, htfContext, bias } = analyzeBias({
    symbol,
    candles: closed4h,
    daily,
    weekly,
    price,
    structurePrice: price4h,
    time,
    analysisTime,
    h1,
    m5,
    // 1h 最近 ACTIVE swing 注入 engine：riskLine = 最近的失效线（1h swing > 4H MSS > 深层保护位），
    // 让 planR 反映日内实际止损（深层保护位常距现价 10%+，用它算 planR 系统性偏低 →"永远空间不足"）。
    internalSwing: { low: internalLow.length ? internalLow[0].price : null, high: internalHigh.length ? internalHigh[0].price : null },
  });
  // 用有效方向（结构失效 → NEUTRAL），避免显示"已过期的旧结构方向"误导；
  // 同时供扫损 Judas Swing 判定（方向与 bias 相反的 NY Open 扫损 = 开盘假动作）
  const effectiveBias = bias.effectiveBias || bias.bias;

  // P1-A：流动性扫损（5m K 线：进行中 5m 实时检测 + 最近 48 根已收盘 5m 确认，≈4 小时窗口）
  // 用 5m 粒度：扫损是分钟级价格行为（刺破流动性后收回），4H 单根 K 会把整个过程包住，粒度过粗
  // 外部结构位补形成时间（externalSwingHighTime/LowTime，4H swing 开盘时间），供扫损消息展示"被扫的流动性是什么时候形成的"
  const extHighState = structure.externalSwingHighState?.state;
  const extLowState = structure.externalSwingLowState?.state;
  const extHigh = structure.externalSwingHigh != null && extHighState !== "BROKEN"
    ? [{ type: "EXTERNAL_HIGH", price: structure.externalSwingHigh, state: extHighState }]
    : [];
  if (extHigh.length && structure.externalSwingHighTime != null) extHigh[0].time = structure.externalSwingHighTime;
  const extLow = structure.externalSwingLow != null && extLowState !== "BROKEN"
    ? [{ type: "EXTERNAL_LOW", price: structure.externalSwingLow, state: extLowState }]
    : [];
  if (extLow.length && structure.externalSwingLowTime != null) extLow[0].time = structure.externalSwingLowTime;
  const buyLevels = (liquidity.buySide || []).filter((x) => !x.state || x.state === "ACTIVE").concat(extHigh.filter((x) => !x.state || x.state === "ACTIVE"), internalHigh);
  const sellLevels = (liquidity.sellSide || []).filter((x) => !x.state || x.state === "ACTIVE").concat(extLow.filter((x) => !x.state || x.state === "ACTIVE"), internalLow);
  const sweep = detectSweeps(m5, buyLevels, sellLevels, price5m, 48, effectiveBias);

  // P1-B：5m 层 MSS/BOS（周期无关检测；5m 用 ICT 最小 swing 窗口每侧 1 根，收盘确认）
  // 仅检测不生成信号：在扫损消息中标注（扫损→收回→MSS 是 ICT 经典链条），供人工判断结构转向。
  // m5 拉取失败（[]）时跳过，不阻断主分析。
  let mss5m = null;
  if (m5.length >= 3) {
    try {
      const cur5m = detectStructureEvents(m5, { price, left: 1, right: 1 });
      if (cur5m.lastEvent) mss5m = { direction: cur5m.direction, lastEvent: cur5m.lastEvent };
    } catch {}
  }

  // P1-C：位移 K（5m 粒度：最近 48 根 5m ≈ 4 小时内出现位移 K，用于收盘报告标注）
  // 门槛 = BODY + VOLUME（ICT 2022）；structureBreak/fvg 为标签（可空），供消息层展示证据
  const dispList = findDisplacements(m5);
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

  // P1-E：最近 Order Block 细类（ICT 2022 L4：BREAKER/REJECTION/STANDARD + FRESH/USED；辅助标注）
  const obList = pdArray.ob || [];
  const ob = obList.length ? obList[obList.length - 1] : null;
  const obSummary = ob
    ? { type: ob.type, kind: ob.kind, state: ob.state, high: ob.high, low: ob.low, status: ob.status, location: ob.location }
    : null;
  // 4H 执行区供 5m“关键位置 MSS”判断：只传方向一致、仍有效的排名结果。
  // 5m 机会层只读取区间，不重新解释 4H PD Array。
  const rankedPdArray = bias.pdArray || { primary: null, alternatives: [] };
  const executionZones = [rankedPdArray.primary, ...(rankedPdArray.alternatives || [])]
    .filter((z) => z && z.top != null && z.bottom != null && z.status === "VALID")
    .map((z) => ({ type: z.type, top: z.top, bottom: z.bottom, location: z.location }));

  // activeVolumeWindow 是统计窗口；ictSession 是课程固定时段，两者不得混称。

  return {
    symbol,
    time: new Date(time).toISOString().slice(0, 16).replace("T", " "),
    price,
    session,
    activeVolumeWindow,
    ictSession,
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
    mss5m, // { direction, lastEvent } | null（5m 层最近 MSS/BOS 事件，扫损消息标注）
    displacement, // { time, direction, ratio, structureBreak, fvg } | null（位移 K，最近 4 小时内，三条件证据齐备）
    ob: obSummary, // { type, kind, state, high, low, status, location } | null（最近 Order Block 细类）
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
    // 推动区间（审计）：区间高低 + 起点/终点 swing 语义（ICT Impulse = Liquidity → Displacement → Expansion）
    range: location && location.rangeType && location.rangeType !== "NONE"
      ? { high: location.high, low: location.low, rangeType: location.rangeType, startReason: location.startReason || null, endReason: location.endReason || null }
      : null,
    // AMD 阶段（Accumulation/Manipulation/Distribution）：只标注不参与 Bias/Decision。
    // 依据最近窗口内证据：位移（分发）> 扫损收回（操纵）> 有证据积累（ER 横盘+区间内+无推进）> 未定。
    // UNSET 时返回 null → 消息层省略阶段行，不误标"积累"。
    amd: (() => {
      const amdStage = computeAmdStage({
        displacement,
        sweep,
        structure,
        range: location && location.rangeType && location.rangeType !== "NONE"
          ? { high: location.high, low: location.low, rangeType: location.rangeType }
          : null,
        mssEvents: mss5m && mss5m.lastEvent ? [mss5m.lastEvent] : [],
        m5,
        price,
        now: time,
      });
      return amdStage.stage === "UNSET" ? null : amdStage;
    })(),
  };
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
        volumeRatio: last.volumeRatio, // 量/均量（BODY + VOLUME 门槛的量证据；无量数据为 null）
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
export async function analyzeSymbols(symbols, { onProgress, force4h = false } = {}) {
  const results = [];
  for (let i = 0; i < symbols.length; i++) {
    const s = symbols[i];
    try {
      results.push(await analyzeSymbol(s, { force4h }));
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
