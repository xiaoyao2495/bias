/**
 * biasMonitor.js — Monitor Step 2：对给定 symbol 列表跑 Daily Bias Engine
 *
 * 每个 symbol 用与 Historical Scanner 完全相同的流程：
 *   拉 4H/1D/1W 历史（已收盘 K）→ 结构/流动性/区间/PD Array/HTF 方向
 *   → computeDailyBias → 输出简洁摘要（Structure/Bias/Scenario/Confidence/Quality/Decision）
 *
 * 实时版没有未来窗口，Quality 用 planR（理论盈亏比 = |Draw−Entry|/Risk）分级代理：
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
  const [h4, daily, weekly, m5, h1] = await Promise.all([
    getHistory(symbol, "4h", HISTORY["4h"], { force: force4h }),
    getHistory(symbol, "1d", HISTORY["1d"]),
    getHistory(symbol, "1w", HISTORY["1w"]),
    // 5m 用于流动性扫损/位移检测（辅助信息，缓存 TTL 5 分钟）；拉取失败降级为 []，
    // 不阻断主分析（否则 5m 抖动会导致整个合约分析失败）
    getKlines(symbol, "5m", 100).catch(() => []),
    // 1h 用于数据驱动 Killzone（活跃窗口）：只取上周一~五（上周交易周）的 1h 成交量分布，
    // 缓存 TTL 一周（每周一刷新，分布短期稳定无需每轮重算）；拉取失败降级为 [] → 非 Killzone
    getKlines(symbol, "1h", 720).catch(() => []),
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

  // 核心判定链路（与 Historical Scanner 共用 analyzeBias，见 engine/analyzeBias.js）
  // session（数据驱动 Killzone）在 analyzeBias 内统一计算：h1 → 上周交易周成交量 →
  // 当前 4H K 覆盖的活跃窗口，同时供 confidence 时机因子与展示使用。
  // P0-4：Session 参考 K 与结构参考 K 拆分——sessionCandle 用原始 h4 末根（进行中 4H）的
  // 时间范围，否则 21:30 会拿 16:00–20:00 那根已收盘 K 判断活跃窗口（滞后最多 4 小时）；
  // 进行中 K 只提供时间范围，不参与任何结构/FVG/OB 判定（那些仍只用 closed4h）。
  const sessionCandle = h4[h4.length - 1];
  const { structure, liquidity, location, pdArray, session, htfContext, bias } = analyzeBias({
    candles: closed4h,
    daily,
    weekly,
    price,
    structurePrice: price4h,
    time,
    analysisTime,
    h1,
    sessionCandle,
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
  const buyLevels = (liquidity.buySide || []).filter((x) => !x.state || x.state === "ACTIVE").concat(extHigh.filter((x) => !x.state || x.state === "ACTIVE"));
  const sellLevels = (liquidity.sellSide || []).filter((x) => !x.state || x.state === "ACTIVE").concat(extLow.filter((x) => !x.state || x.state === "ACTIVE"));
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
  // 保留三条件证据（structureBreak/fvg），供消息层展示"为什么算 ICT 位移"而非仅凭大实体
  const dispList = findDisplacements(m5);
  // 收盘报告只能展示“刚收完的这根 4H”内部发生的 5m 位移，不能用滚动四小时窗口，
  // 否则边界附近会把上一根或新一根 4H 的位移拼到本根报告里。
  const displacement = displacementFor4h(dispList, lastClosed);

  const decision = bias.decision || {};
  const planR = decision.planR ?? null;
  const quality = planR == null ? "-" : planR >= 1 ? "HIGH" : planR >= 0.5 ? "MEDIUM" : "LOW";

  // P1-E：最近 Order Block 细类（ICT 2022 L4：BREAKER/REJECTION/STANDARD + FRESH/USED；辅助标注）
  const obList = pdArray.ob || [];
  const ob = obList.length ? obList[obList.length - 1] : null;
  const obSummary = ob
    ? { type: ob.type, kind: ob.kind, state: ob.state, high: ob.high, low: ob.low, status: ob.status, location: ob.location }
    : null;

  // 数据驱动 Killzone（真实活跃窗口）：由 analyzeBias 计算（见上）。
  // 返回 { start, end, ratio } | null（ratio = 窗口成交量占比%）；无数据 → null → "非 Killzone"

  return {
    symbol,
    time: new Date(time).toISOString().slice(0, 16).replace("T", " "),
    price,
    session,
    // 最后已收盘 4H（收盘报告用：收于开盘上方/下方）
    last4h: { open: lastClosed.open, close: lastClosed.close, openTime: lastClosed.time, time: lastClosed.closeTime },
    // 用有效方向（结构失效 → NEUTRAL），避免显示"已过期的旧结构方向"误导
    bias: effectiveBias,
    structureBias: bias.structureBias || bias.bias,
    narrativeBias: bias.narrativeBias || bias.bias,
    htfContext,
    provisionalStructureBreak: bias.provisionalStructureBreak || null,
    reversalEvidence: bias.reversalEvidence || null,
    structureStatus: bias.structureStatus,
    invalidation: bias.invalidation || null, // { type, price }：结构失效时用于解释"突破哪个保护位"
    mss: bias.mss
      ? { ...bias.mss, time: new Date(time).toISOString().slice(0, 16).replace("T", " ") } // MSS 事件：方向/保护位/触发时间
      : null,
    scenario: bias.scenario ? bias.scenario.label : "-",
    confidence: bias.confidence ? bias.confidence.level : "-",
    confidenceScore: bias.confidence ? bias.confidence.score : null,
    sweep, // { side, type, level, sweptPrice, close, time } | null（流动性扫损事件）
    mss5m, // { direction, lastEvent } | null（5m 层最近 MSS/BOS 事件，扫损消息标注）
    displacement, // { time, direction, ratio, structureBreak, fvg } | null（位移 K，最近 4 小时内，三条件证据齐备）
    ob: obSummary, // { type, kind, state, high, low, status, location } | null（最近 Order Block 细类）
    quality,
    planR,
    decision: decision.decision || "-",
    decisionLabel: decisionLabel(decision.decision),
    reason: decision.reason || "-",
    execution: bias.executionState || "-",
    location: location.location,
    context: location.context || "-",
  };
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
        console.log(`Session: ${r.session ? `活跃窗口 ${String(r.session.start).padStart(2, "0")}:00-${String(r.session.end).padStart(2, "0")}:00（占比 ${r.session.ratio}%）` : "非 Killzone"}`);
        console.log(`Scenario: ${r.scenario}`);
        console.log(`信心度: ${r.confidence}${r.confidenceScore != null ? ` ${r.confidenceScore}` : ""}`);
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
