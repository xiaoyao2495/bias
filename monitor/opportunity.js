/**
 * opportunity.js — 5m 机会扫描器（Monitor Step 4）
 *
 * 目标：把 4H 环境监控升级为 5m 机会发现。
 * 在 4H Bias 方向明确（BULLISH/BEARISH）的前提下，扫描 5m 层的 ICT 入场触发器：
 *
 *   RETRACE — 价格正在回踩同向 5m FVG/OB（执行区未过度消耗）→ 回踩入场
 *   CHAIN   — 扫损(SSL/BSL) → 5m MSS（位移确认）→ 回踩同向执行区（完整 ICT 链条）→ 最高质量
 *
 * 结构证据（不直接产生入场）：MSS/BOS 仅建立"结构已转移/延续"的证据。
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
import { findFvgs, findOrderBlocks, annotatePDArray } from "../indicators/pdArray.js";

// ---- 常量 ----
const ZONE_AGE_MAX = 60; // 执行区最大年龄（根 5m = 5 小时，太旧价值低）
const ZONE_MARGIN = 0.003; // 执行区贴边容差（±0.3% 视为"正在回踩"）
const SWEEP_WINDOW_MS = 4 * 3600_000; // 扫损有效窗口（4 小时，与 sweep.js window=48 一致）
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
  const closed = m5.filter((k) => !k.closeTime || k.closeTime <= Date.now());
  if (closed.length < 3) {
    return { direction: "NEUTRAL", lastHigh: null, lastLow: null, pd: { fvg: [], ob: [] }, events: [] };
  }
  const structure = detectStructureEvents(closed, { price, left: 1, right: 1 });
  const fvgs = findFvgs(closed);
  const obs = findOrderBlocks(closed);
  // annotatePDArray 需要 range（dealing range）做 PREMIUM/DISCOUNT 标注；
  // 机会扫描只用 age/status，传 null 即可（location 为 null，不影响）。
  const pd = annotatePDArray({ fvg: fvgs.slice(-40), ob: obs.slice(-40) }, null, closed);
  const events = scanStructureEvents(closed, { lookback: 50, left: 1, right: 1 });
  return {
    direction: structure.direction,
    lastHigh: structure.structureLayer ? structure.structureLayer.internal.lastHigh : null,
    lastLow: structure.structureLayer ? structure.structureLayer.internal.lastLow : null,
    pd, // { fvg: [...], ob: [...] }，annotated：age/status
    events, // 最近 MSS/BOS（时间升序，收盘确认）
  };
}

/**
 * 扫描 5m 机会（顺 4H Bias 方向）。
 * @param {Object} p
 * @param {string} p.symbol
 * @param {Object} p.env analyzeSymbol 摘要（见文件头）
 * @param {Array} p.m5 较长 5m 历史
 * @returns {Array<{symbol,type,direction,entry,zone,trigger,score,key,time}>} 机会列表（按评分降序）
 */
export function scanOpportunities({ symbol, env, m5 }) {
  // 兼容 monitor overview 的 { cur: { bias/... }, price/... } 结构；正式编排会先展开，
  // 此处再做防御，避免其他调用方误传嵌套环境时静默返回空机会。
  env = env?.cur ? { ...env, ...env.cur } : env;
  const bias = env?.bias;
  if (bias !== "BULLISH" && bias !== "BEARISH") return [];
  // 4H 决策层 NO_TRADE（方向概率过低/无空间）→ 环境层不找入场，避免"环境说别交易、
  // 机会层却推顺 bias 做单"的自相矛盾。审计修复：此前仅靠评分门槛，CHAIN 在
  // confidence LOW + quality HIGH + 活跃窗口时可凑够 60 分越过门槛推送。
  if (env.decision === "NO_TRADE" || env.decisionLabel === "NO TRADE") return [];
  if (!m5 || m5.length < 20) return [];

  const price = env.price;
  const ctx = computeM5Context(m5, price);
  const zones = collectZones(ctx, bias);

  const opps = [];
  const chain = detectChain({ env, ctx, bias, price, zones });
  if (chain) opps.push(chain);
  const retrace = detectRetrace({ bias, price, zones });
  if (retrace) opps.push(retrace);

  for (const o of opps) {
    o.symbol = symbol;
    o.score = scoreOpportunity(o, env);
  }
  return opps
    .filter((o) => o.score >= OPP_MIN_SCORE)
    .sort((a, b) => b.score - a.score);
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
    // P1：已填平（FILLED）的 FVG 彻底失效 → 无条件排除（此前 12 根以内仍可产生回踩机会）；
    // CE_REACHED（触及中点）保留参考价值，仅过旧的区放弃
    if (it.status === "FILLED") continue;
    if (it.status === "CE_REACHED" && it.age > 12) continue;
    const top = it.top ?? it.high;
    const bottom = it.bottom ?? it.low;
    if (top == null || bottom == null || top <= bottom) continue;
    zones.push({
      type: it.type.includes("FVG") ? "FVG" : "OB",
      sourceType: it.type,
      direction: bias,
      top,
      bottom,
      mid: (top + bottom) / 2,
      // 来源字段（CHAIN 精确匹配 + 审计）：
      //   index — FVG：确认 K 索引（findFvgs 的 i）；OB：推动 OB 的位移 K 索引（位移驱动）或突破 K 索引（fallback）
      //   time — FVG：中间根开盘；OB：OB 所在 K 开盘
      //   displacement — 仅 OB 有意义（位移驱动生成）；FVG 无此字段 → false
      index: it.index,
      time: it.time,
      displacement: it.displacement === true,
      age: it.age,
      status: it.status,
    });
  }
  // 按年龄升序（最近形成优先），过滤掉当前价已大幅偏离的区
  return zones.sort((a, b) => a.age - b.age);
}

/** 信号 1 — 执行区回踩：价格正贴在/位于同向 FVG/OB 区间内（顺位端 = 入场参考） */
function detectRetrace({ bias, price, zones }) {
  if (!zones.length) return null;
  const margin = price * ZONE_MARGIN;
  let best = null;
  for (const z of zones) {
    if (price < z.bottom - margin || price > z.top + margin) continue; // 不在区内/贴边
    // 多头从上方回踩（price 不得深破 bottom）；空头从下方回踩（不得深破 top）
    const sideOk = bias === "BULLISH" ? price >= z.bottom - margin : price <= z.top + margin;
    if (!sideOk) continue;
    const dist = bias === "BULLISH" ? price - z.bottom : z.top - price; // 距顺位端距离
    if (!best || dist < best.dist) best = { z, dist };
  }
  if (!best) return null;
  const z = best.z;
  // P1：状态文案分层（OPEN 未消耗 / TOUCHED 刚被触碰 / CE_REACHED 已回补 / FILLED 已填平）
  const zoneState = z.status === "FILLED" ? "已填平" : z.status === "CE_REACHED" ? "已回补" : z.status === "TOUCHED" ? "刚被触碰" : "未消耗";
  return {
    type: "RETRACE",
    direction: bias,
    entry: bias === "BULLISH" ? z.bottom : z.top,
    zone: { type: z.type, top: z.top, bottom: z.bottom },
    trigger: `价格回踩 ${z.type} ${fmtNum(z.bottom)}-${fmtNum(z.top)}（${z.age} 根 5m 前形成，${zoneState}）`,
    key: `RETRACE_${bias}_${z.bottom.toFixed(2)}_${z.top.toFixed(2)}`,
    time: Date.now(),
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
 * P1：MSS 突破腿必须为位移确认（实体扩张 + FVG，confirmedByDisplacement=true）——
 * 低动能、贴线式结构转移不构成机构链条，否则 扫损→MSS→回踩 会频繁误报。
 * P1：CHAIN 执行区必须由该 MSS 位移腿产生（linkedToMss 按索引/价格精确匹配），
 * 普通 RETRACE 仍可用全部有效执行区，但高质量 CHAIN 不用旧 FVG/OB 拼凑。
 */
function detectChain({ env, ctx, bias, price, zones }) {
  const sweep = env.sweep;
  if (!sweep) return null;
  const sweepTime = sweep.time;
  if (!sweepTime || Date.now() - sweepTime > SWEEP_WINDOW_MS) return null;
  const expectedMssDir = sweep.side === "BSL" ? "DOWN" : "UP"; // 扫 BSL → 预期向下跌破；扫 SSL → 预期向上突破
  const dirOk = bias === "BULLISH" ? expectedMssDir === "UP" : expectedMssDir === "DOWN";
  if (!dirOk) return null; // 扫损方向与 4H bias 相反 → 反势链，环境不顺 → 不报
  const mss = ctx.events.find(
    (e) => e.type === "MSS" && e.direction === expectedMssDir && e.time >= sweepTime && e.confirmedByDisplacement
  );
  if (!mss) return null;
  // 且价格已回踩/接近该 MSS 位移腿产生的执行区
  if (!zones.length) return null;
  const margin = price * ZONE_MARGIN;
  const z = zones.find((zone) => linkedToMss(zone, mss) && price >= zone.bottom - margin && price <= zone.top + margin);
  if (!z) return null;
  return {
    type: "CHAIN",
    direction: bias,
    entry: bias === "BULLISH" ? z.bottom : z.top,
    // 保留来源便于审计：哪个执行区、由哪条位移腿产生
    zone: { type: z.type, top: z.top, bottom: z.bottom, index: z.index, displacement: z.displacement },
    mssIndex: mss.atIndex,
    trigger: `扫损${sweep.side === "BSL" ? "BSL" : "SSL"} → 5m MSS（位移确认）${expectedMssDir === "UP" ? "向上" : "向下"} → 回踩 ${z.type} ${fmtNum(z.bottom)}-${fmtNum(z.top)}`,
    key: `CHAIN_${bias}_${z.bottom.toFixed(2)}_${sweep.key || sweepTime}`,
    time: mss.time,
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
  if (env.session) s += 10; // 处于活跃窗口（Killzone）
  if (env.structureStatus === "VALID") s += 5; // 4H 结构有效
  // 信号类型权重：完整链条 > 执行区回踩
  if (o.type === "CHAIN") s += 25;
  else s += 10; // RETRACE
  if (o.zone) s += 5; // 有明确执行区（可挂单）
  return Math.min(100, s);
}

/** 数字显示：整数原样，小数保留 2 位去尾零 */
function fmtNum(n) {
  if (n == null) return "-";
  return String(Number(Number(n).toFixed(2)));
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
  const env = { bias: process.argv[3] || "BULLISH", price, confidence: "MEDIUM", quality: "HIGH", session: { start: 20, end: 24, ratio: 23.4 }, structureStatus: "VALID", sweep: null };
  const opps = scanOpportunities({ symbol, env, m5 });
  const ctx = computeM5Context(m5, price);
  console.log(`${symbol} 现价 ${price} | 5m 结构 ${ctx.direction} | MSS/BOS 事件 ${ctx.events.length} | FVG ${ctx.pd.fvg.length} OB ${ctx.pd.ob.length}`);
  if (!opps.length) console.log("（无 ≥60 分机会）");
  for (const o of opps) {
    console.log(`[${o.score}] ${o.type} ${o.direction} entry=${o.entry}${o.zone ? ` zone=${o.zone.type} ${o.zone.bottom}-${o.zone.top}` : ""}`);
    console.log(`   ${o.trigger}`);
  }
}
