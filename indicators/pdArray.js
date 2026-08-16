/**
 * pdArray.js — PD Array：FVG 与 Order Block
 *
 * FVG（三根 K）：定义正确，保持。
 *   Bullish FVG : K1.high < K3.low  → 向上缺口，top = K3.low, bottom = K1.high
 *   Bearish FVG : K1.low  > K3.high → 向下缺口，top = K1.low,  bottom = K3.high
 *
 * Order Block（ICT 2022 工程化定义）：
 *   - 必须是 MSS/BOS 结构突破位移腿之前、该因果腿内最后一根反向收盘 K；
 *   - 普通“阴线后阳线 / 阳线后阴线”只是形态，不能单独建立 OB；
 *   - 创建 OB 的位移腿不算 mitigation，只有确认后的价格重新访问才消耗该区域；
 *   - 原 OB 收盘越过远端后失效。若反向结构位移确认失败交付，则另建方向翻转的 Breaker，
 *     不把失效 OB 改名后继续沿用原方向。
 *
 * FVG/OB 增加 direction / age / location / lifecycle，并由 rankPDArray
 *   用于把 PD Array 作为"执行区域"（不参与 bias 判定）：同向 + 在顺位一侧 → VALID Primary。
 *
 * FVG 的课程语义与工程执行过滤严格分层：
 *   - ictValid：只由三根 K 几何和缺口是否仍存在决定；
 *   - executable：在 ictValid 基础上，再应用 ATR/tick/百分比最小宽度过滤。
 * ATR 只能影响交易执行质量，不能否定一个几何上成立的 ICT FVG。
 */

import { findDisplacements } from "./displacement.js";
import { causalRangeId, rangeForEvent, stableDisplacementId } from "./causalIdentity.js";
import { tradingDayIdAt } from "./instrumentProfile.js";

/** 找出所有 FVG */
export function findFvgs(candles) {
  const fvgs = [];
  for (let i = 2; i < candles.length; i++) {
    const k1 = candles[i - 2];
    const k3 = candles[i];
    if (k3.low > k1.high) {
      fvgs.push({ type: "BULLISH_FVG", direction: "BULLISH", top: k3.low, bottom: k1.high, index: i, middleIndex: i - 1, time: candles[i - 1].time, confirmedAt: k3.closeTime ?? k3.time });
    }
    if (k1.low > k3.high) {
      fvgs.push({ type: "BEARISH_FVG", direction: "BEARISH", top: k1.low, bottom: k3.high, index: i, middleIndex: i - 1, time: candles[i - 1].time, confirmedAt: k3.closeTime ?? k3.time });
    }
  }
  return fvgs;
}

export const FVG_EXECUTION_DEFAULTS = Object.freeze({
  atrRatio: 0.10,
  minTicks: 3,
  minWidthPct: 0.02,
  atrPeriod: 14,
});

/** 从实际 OHLC 小数精度保守推断最小跳动；调用方有交易所 tickSize 时应显式传入。 */
export function inferTickSize(candles) {
  const values = (candles || []).slice(-200).flatMap((k) => [k.open, k.high, k.low, k.close]).filter(Number.isFinite);
  if (!values.length) return null;
  const decimals = (n) => {
    const s = Math.abs(n).toFixed(10).replace(/0+$/, "");
    return Math.max(0, s.length - s.indexOf(".") - 1);
  };
  const places = Math.min(8, Math.max(...values.map(decimals)));
  const scale = 10 ** places;
  return 1 / scale;
}

function atrAt(candles, index, period) {
  const from = Math.max(0, index - period + 1);
  let total = 0;
  let count = 0;
  for (let i = from; i <= index; i++) {
    const k = candles[i];
    if (!k) continue;
    const prevClose = candles[i - 1]?.close;
    const tr = prevClose == null
      ? k.high - k.low
      : Math.max(k.high - k.low, Math.abs(k.high - prevClose), Math.abs(k.low - prevClose));
    if (Number.isFinite(tr) && tr >= 0) { total += tr; count++; }
  }
  return count ? total / count : null;
}

function sameFvg(a, b) {
  if (!a || !b) return false;
  const near = (x, y) => Math.abs(x - y) / Math.max(Math.abs(y), 1e-9) < 0.000001;
  return near(a.top, b.top) && near(a.bottom, b.bottom);
}

/**
 * 给 FVG 增加课程有效性和执行质量：动态宽度、位移/结构关联与稳定 id。
 * quality = RAW | DISPLACEMENT | STRUCTURE 描述因果质量；executionQuality 描述工程宽度。
 * 几何 FVG 不因 ATR/tick 门槛而失去 ICT 身份；完全被 wick 交易穿越后原 FVG 已填补。
 */
export function annotateFvgQuality(fvgs, candles, {
  displacements = [],
  structureEvents = [],
  tickSize = inferTickSize(candles),
  atrRatio = FVG_EXECUTION_DEFAULTS.atrRatio,
  minTicks = FVG_EXECUTION_DEFAULTS.minTicks,
  minWidthPct = FVG_EXECUTION_DEFAULTS.minWidthPct,
  atrPeriod = FVG_EXECUTION_DEFAULTS.atrPeriod,
  currentRange = null,
  priorRange = null,
  profile = null,
  timeframe = null,
} = {}) {
  return (fvgs || []).map((fvg) => {
    const width = fvg.top - fvg.bottom;
    const midpoint = (fvg.top + fvg.bottom) / 2;
    const atr = atrAt(candles || [], fvg.index, atrPeriod);
    const widthPct = midpoint > 0 ? width / midpoint * 100 : null;
    const widthAtr = atr > 0 ? width / atr : null;
    const ticks = tickSize > 0 ? width / tickSize : null;
    const minWidth = Math.max(
      tickSize > 0 ? tickSize * minTicks : 0,
      atr > 0 ? atr * atrRatio : 0,
      midpoint > 0 ? midpoint * minWidthPct / 100 : 0,
    );
    const displacement = (displacements || []).find((d) => d.confirmationIndex === fvg.index && sameFvg(d.fvg, fvg));
    const structureEvent = (structureEvents || []).find((e) =>
      e.confirmed && e.confirmedByDisplacement
      && e.displacementConfirmationIndex === fvg.index
      && sameFvg(e.displacementFvg, fvg));
    const quality = structureEvent ? "STRUCTURE" : displacement ? "DISPLACEMENT" : "RAW";
    const executionStatus = fvg.executionStatus || fvg.status || "OPEN";
    const wickStatus = fvg.status || "OPEN";
    const filled = wickStatus === "FILLED" || executionStatus === "FILLED" || executionStatus === "WICK_FILLED";
    // ICT 2022 的 FVG 身份只取决于三根 K 几何以及该缺口是否仍存在。ATR/tick/百分比
    // 只评价这个区域是否值得实际挂单，不能反过来否定课程意义上的 FVG。
    const ictValid = width > 0 && !filled;
    const meetsExecutionWidth = width >= minWidth;
    const executionQuality = !ictValid ? "INACTIVE" : meetsExecutionWidth ? "STANDARD" : "THIN";
    const valid = ictValid; // 兼容旧调用方：valid 现在明确表示 ICT/生命周期有效，而非宽度门槛。
    // provenanceStatus is also emitted in audit-only annotation passes.  Only an
    // explicit strict-range rejection may disable execution here; otherwise the
    // exact structure event below can still supply the immutable origin identity.
    const provenanceRejected = fvg.rejectionReason === "RANGE_IDENTITY_MISMATCH";
    const executable = ictValid && meetsExecutionWidth && !provenanceRejected;
    // index 会随着固定长度 K 线窗口向前滚动而变化，不能用于跨轮询去重。
    // FVG 的中间根开盘时间 + 原始价格边界在不同窗口中保持不变，才是真正稳定的身份。
    const identityTime = fvg.time ?? candles?.[fvg.index - 1]?.time ?? fvg.index;
    const id = `${fvg.type}_${identityTime}_${String(fvg.bottom)}_${String(fvg.top)}`;
    // 结构级 FVG 继承其结构事件身份；RAW/DISPLACEMENT FVG 则只在其第三根 K
    // 收盘确认时 Range 已经 ACTIVE 的情况下冻结身份，绝不使用无条件 current fallback。
    const formationTime = fvg.confirmedAt ?? candles?.[fvg.index]?.closeTime ?? candles?.[fvg.index]?.time ?? null;
    const formationRange = !structureEvent && !causalRangeId(fvg)
      ? rangeForEvent({ time: formationTime, index: fvg.index }, { currentRange, priorRange, allowOriginLeg: false })
      : null;
    const originRangeId = causalRangeId(structureEvent) || causalRangeId(fvg) || formationRange?.rangeId || null;
    const displacementId = structureEvent?.displacementId
      ?? fvg.displacementId
      ?? (displacement ? stableDisplacementId(candles, { ...displacement, displacementIndex: displacement.index }, timeframe) : null);
    return {
      ...fvg,
      id,
      quality,
      structureEventId: structureEvent?.id ?? fvg.structureEventId ?? null,
      displacementId,
      originRangeId,
      rangeId: originRangeId,
      rangeVersion: structureEvent?.rangeVersion ?? fvg.rangeVersion ?? formationRange?.version ?? null,
      tradingDayId: structureEvent?.tradingDayId ?? fvg.tradingDayId
        ?? (formationTime == null ? null : tradingDayIdAt(formationTime, profile)),
      timeframe: structureEvent?.timeframe ?? fvg.timeframe ?? timeframe ?? null,
      displacementIndex: displacement?.index ?? structureEvent?.displacementIndex ?? null,
      structureEventType: structureEvent?.type ?? null,
      width,
      widthPct,
      widthAtr,
      tickSize,
      ticks,
      minWidth,
      ictValid,
      meetsExecutionWidth,
      executionQuality,
      valid,
      executable,
      rejectionReason: executable
        ? null
        : provenanceRejected
          ? "RANGE_IDENTITY_MISMATCH"
          : filled
          ? "MITIGATED"
          : width < minWidth
            ? "TOO_NARROW"
            : null,
    };
  });
}

export function isExecutableFvg(fvg) {
  return !!fvg && fvg.executable === true;
}

/**
 * 判断课程意义上的 FVG 是否仍然有效。兼容升级前只有 valid/executable 的持久化对象，
 * 但明确排除已经被 wick 或 close 完全填补的缺口。
 */
export function isIctValidFvg(fvg) {
  if (!fvg) return false;
  const status = fvg.executionStatus || fvg.status;
  if (status === "FILLED" || status === "WICK_FILLED") return false;
  if (typeof fvg.ictValid === "boolean") return fvg.ictValid;
  if (typeof fvg.valid === "boolean") return fvg.valid;
  return fvg.executable === true;
}

export const OB_LIFECYCLE = Object.freeze({
  FRESH: "FRESH",
  MITIGATED: "MITIGATED",
  CE_REACHED: "CE_REACHED",
  INVALIDATED: "INVALIDATED",
});

function displacementIndex(d, candles) {
  if (Number.isInteger(d?.index)) return d.index;
  return candles.findIndex((k) => k.closeTime === d?.time);
}

function linkedStructureEvent(d, structureEvents, candles) {
  const idx = displacementIndex(d, candles);
  return (structureEvents || []).find((event) =>
    event?.confirmed === true
    && event?.confirmedByDisplacement === true
    && event?.displacementIndex === idx
    && event?.direction === d.direction
    && (event?.type === "MSS" || event?.type === "BOS")) || null;
}

function structuralDisplacement(d, structureEvents, candles, requireStructureEvent = false) {
  const event = linkedStructureEvent(d, structureEvents, candles);
  const structureBreak = d?.structureBreak;
  const qualified = !!event || (!requireStructureEvent && (
    structureBreak?.type === "BOS"
    && structureBreak?.direction === d?.direction
    && Number.isInteger(structureBreak?.swingIndex)
  ));
  return qualified ? { event, structureBreak } : null;
}

/** 在结构突破的因果腿内，找推动位移之前最后一根反向收盘 K。 */
function findSourceCandle(candles, idx, direction, structure) {
  const swingIndex = structure?.event?.swingIndex ?? structure?.structureBreak?.swingIndex;
  const lowerBound = Number.isInteger(swingIndex) ? Math.max(0, Math.min(swingIndex, idx - 1)) : idx - 1;
  for (let i = idx - 1; i >= lowerBound; i--) {
    const k = candles[i];
    const opposing = direction === "UP" ? k.close < k.open : k.close > k.open;
    if (opposing) return { candle: k, index: i };
  }
  return null;
}

/** OB/Breaker 的消耗只从确认 K 之后开始；创建或激活它的位移腿不算回踩。 */
function lifecycleAfter(candles, { high, low, direction, confirmedIndex }) {
  const midpoint = (high + low) / 2;
  let state = OB_LIFECYCLE.FRESH;
  let mitigatedAt = null;
  let ceReachedAt = null;
  let invalidatedAt = null;
  let mitigatedTime = null;
  let ceReachedTime = null;
  let invalidatedTime = null;
  for (let i = confirmedIndex + 1; i < candles.length; i++) {
    const k = candles[i];
    const invalidated = direction === "BULLISH" ? k.close < low : k.close > high;
    if (invalidated) {
      state = OB_LIFECYCLE.INVALIDATED;
      invalidatedAt = i;
      invalidatedTime = k.closeTime ?? k.time ?? null;
      break;
    }
    const overlap = k.low <= high && k.high >= low;
    if (!overlap) continue;
    if (mitigatedAt == null) {
      mitigatedAt = i;
      mitigatedTime = k.closeTime ?? k.time ?? null;
    }
    const reachedCe = direction === "BULLISH" ? k.low <= midpoint : k.high >= midpoint;
    if (reachedCe) {
      state = OB_LIFECYCLE.CE_REACHED;
      if (ceReachedAt == null) {
        ceReachedAt = i;
        ceReachedTime = k.closeTime ?? k.time ?? null;
      }
    } else if (state === OB_LIFECYCLE.FRESH) {
      state = OB_LIFECYCLE.MITIGATED;
    }
  }
  return { state, mitigatedAt, ceReachedAt, invalidatedAt, mitigatedTime, ceReachedTime, invalidatedTime };
}

function buildOrderBlock(candles, source, idx, d, structure) {
  const bullish = d.direction === "UP";
  const high = source.candle.high;
  const low = source.candle.low;
  if (![high, low].every(Number.isFinite) || !(high > low)) return null;
  const direction = bullish ? "BULLISH" : "BEARISH";
  const type = bullish ? "BULLISH_OB" : "BEARISH_OB";
  const midpoint = (high + low) / 2;
  const lifecycle = lifecycleAfter(candles, { high, low, direction, confirmedIndex: idx });
  const identityTime = source.candle.time ?? source.candle.closeTime ?? source.index;
  const event = structure.event;
  return {
    id: `${type}_${identityTime}_${String(low)}_${String(high)}`,
    type,
    direction,
    high,
    low,
    top: high,
    bottom: low,
    midpoint,
    consequentEncroachment: midpoint,
    proximal: bullish ? high : low,
    distal: bullish ? low : high,
    bodyHigh: Math.max(source.candle.open, source.candle.close),
    bodyLow: Math.min(source.candle.open, source.candle.close),
    openPrice: source.candle.open,
    index: idx,
    sourceIndex: source.index,
    time: identityTime,
    confirmedAt: candles[idx]?.closeTime ?? candles[idx]?.time,
    confirmed: true,
    ict: true,
    experimental: false,
    quality: "STRUCTURE",
    kind: "STANDARD",
    state: lifecycle.state,
    lifecycleState: lifecycle.state,
    status: lifecycle.state,
    executable: lifecycle.state !== OB_LIFECYCLE.INVALIDATED,
    displacement: true,
    displacementIndex: idx,
    displacementQuality: d.quality ?? null,
    structureEventType: event?.type ?? structure.structureBreak?.type ?? "BOS",
    structureEventId: event?.id ?? null,
    structureLevel: event?.level ?? structure.structureBreak?.level ?? null,
    swingIndex: event?.swingIndex ?? structure.structureBreak?.swingIndex ?? null,
    originRangeId: causalRangeId(event),
    rangeId: causalRangeId(event),
    rangeVersion: event?.rangeVersion ?? null,
    tradingDayId: event?.tradingDayId ?? null,
    displacementId: event?.displacementId ?? null,
    timeframe: event?.timeframe ?? null,
    mitigatedAt: lifecycle.mitigatedAt,
    ceReachedAt: lifecycle.ceReachedAt,
    invalidatedAt: lifecycle.invalidatedAt,
    mitigatedTime: lifecycle.mitigatedTime,
    ceReachedTime: lifecycle.ceReachedTime,
    invalidatedTime: lifecycle.invalidatedTime,
  };
}

function buildBreaker(candles, original, activationIndex, d, structure) {
  const direction = original.direction === "BULLISH" ? "BEARISH" : "BULLISH";
  const type = direction === "BULLISH" ? "BULLISH_BREAKER" : "BEARISH_BREAKER";
  const lifecycle = lifecycleAfter(candles, {
    high: original.high,
    low: original.low,
    direction,
    confirmedIndex: activationIndex,
  });
  const event = structure.event;
  return {
    ...original,
    id: `${type}_${original.time}_${String(original.low)}_${String(original.high)}_${candles[activationIndex]?.time ?? activationIndex}`,
    type,
    direction,
    proximal: direction === "BULLISH" ? original.high : original.low,
    distal: direction === "BULLISH" ? original.low : original.high,
    index: activationIndex,
    confirmedAt: candles[activationIndex]?.closeTime ?? candles[activationIndex]?.time,
    quality: "STRUCTURE",
    kind: "BREAKER",
    state: lifecycle.state,
    lifecycleState: lifecycle.state,
    status: lifecycle.state,
    executable: lifecycle.state !== OB_LIFECYCLE.INVALIDATED,
    displacementIndex: activationIndex,
    displacementQuality: d.quality ?? null,
    structureEventType: event?.type ?? structure.structureBreak?.type ?? "BOS",
    structureEventId: event?.id ?? null,
    structureLevel: event?.level ?? structure.structureBreak?.level ?? null,
    swingIndex: event?.swingIndex ?? structure.structureBreak?.swingIndex ?? null,
    originRangeId: causalRangeId(event),
    rangeId: causalRangeId(event),
    rangeVersion: event?.rangeVersion ?? null,
    tradingDayId: event?.tradingDayId ?? null,
    displacementId: event?.displacementId ?? null,
    timeframe: event?.timeframe ?? null,
    sourceObId: original.id,
    sourceObType: original.type,
    sourceObInvalidatedAt: original.invalidatedAt,
    activationIndex,
    invalidatedAt: lifecycle.invalidatedAt,
    mitigatedAt: lifecycle.mitigatedAt,
    ceReachedAt: lifecycle.ceReachedAt,
    mitigatedTime: lifecycle.mitigatedTime,
    ceReachedTime: lifecycle.ceReachedTime,
    invalidatedTime: lifecycle.invalidatedTime,
  };
}

/**
 * 找出 ICT 2022 Order Block 与由失败 OB 派生的 Breaker。
 * 只有“确认 MSS/BOS 的结构位移腿”能够创建 OB；不再提供阴阳线组合 fallback。
 */
export function findOrderBlocks(candles, options = {}) {
  const { displacements } = options;
  const structureEvents = options.structureEvents || [];
  // 正式 engine/monitor 会显式传入它们自己的周期结构事件，此时必须精确关联，不能再用
  // displacement.js 的 1/1 swing BOS 标签绕过 4H 2/2 或 5m 1/1 的统一结构口径。
  // 独立调用未提供 structureEvents 时，才允许使用 displacement 自带 BOS 标签。
  const requireStructureEvent = Object.prototype.hasOwnProperty.call(options, "structureEvents");
  const dispList = displacements ?? findDisplacements(candles);
  const qualified = [];
  for (const d of dispList) {
    const idx = displacementIndex(d, candles);
    if (idx <= 0 || idx >= candles.length) continue;
    const structure = structuralDisplacement(d, structureEvents, candles, requireStructureEvent);
    if (!structure) continue;
    qualified.push({ d, idx, structure });
  }
  qualified.sort((a, b) => a.idx - b.idx);

  const originals = [];
  const ids = new Set();
  for (const item of qualified) {
    const source = findSourceCandle(candles, item.idx, item.d.direction, item.structure);
    if (!source) continue;
    const ob = buildOrderBlock(candles, source, item.idx, item.d, item.structure);
    if (!ob || ids.has(ob.id)) continue;
    ids.add(ob.id);
    originals.push(ob);
  }

  const breakers = [];
  for (const ob of originals) {
    if (ob.invalidatedAt == null) continue;
    const opposite = ob.direction === "BULLISH" ? "DOWN" : "UP";
    // Breaker 的角色反转必须由“直接使原 OB 失败”的同一根位移 MSS 建立。
    // 普通 BOS、普通收破或数根以后才出现的位移，不能事后把旧 OB 美化成 Breaker。
    const activation = qualified.find(({ d, idx, structure }) =>
      idx === ob.invalidatedAt
      && d.direction === opposite
      && structure.event?.type === "MSS"
      && (opposite === "DOWN" ? candles[idx].close < ob.low : candles[idx].close > ob.high));
    if (!activation) continue;
    breakers.push(buildBreaker(candles, ob, activation.idx, activation.d, activation.structure));
  }

  return [...originals, ...breakers].sort((a, b) => a.index - b.index || (a.kind === "STANDARD" ? -1 : 1));
}

/**
 * V1.6：给 FVG/OB 标注执行属性。
 *   location：区间中点相对 dealing range 中线 → PREMIUM / DISCOUNT / AT_EQ
 *   age     ：距当前 K 的根数（越小越新）
 *   status ：
 *     FVG 四态（P1 语义修正：CE 是触及中点，FILLED 才是触及远端；消耗单向递增不降级）——
 *       OPEN      未进入缺口（Bullish: low 恒 > top；Bearish: high 恒 < bottom）
 *       TOUCHED   进入缺口但未到中点（Bullish: low ≤ top 且 low > mid；Bearish 对称）
 *       CE_REACHED触及中点（Bullish: low ≤ mid；Bearish: high ≥ mid）
 *       FILLED    触及远端（Bullish: low ≤ bottom；Bearish: high ≥ top）＝缺口完全回补＝彻底失效
 *     消耗深度由整个形成后区间的最深触及一次性决定，只允许升级、不允许降级
 *     （先触及中点后浅回踩的 FVG 不得从 CE_REACHED 降回 TOUCHED）。
 *     OB 四态由 findOrderBlocks 维护：FRESH / MITIGATED / CE_REACHED / INVALIDATED。
 */
export function annotatePDArray(pdArray, range, candles, { requireRangeIdentity = false } = {}) {
  const currentIndex = candles.length - 1;
  const eq = range && range.equilibrium;

  const annotate = (item) => {
    const mid = (item.top + item.bottom) / 2;
    const location = eq == null ? null : mid > eq ? "PREMIUM" : mid < eq ? "DISCOUNT" : "AT_EQ";
    const age = currentIndex - item.index;
    let status = "OPEN";
    let closeStatus = "OPEN";
    let firstTouchAt = item.firstTouchAt ?? null;
    let ceReachedAt = item.ceReachedAt ?? null;
    let filledAt = item.filledAt ?? null;
    let closeFilledAt = item.closeFilledAt ?? null;
    if (item.type === "BULLISH_FVG") {
      // P1：消耗深度由整个形成后区间的最低 low 一次性决定（单向递增，OPEN < TOUCHED < CE_REACHED < FILLED）。
      // 逐根覆盖会让"先触及中点后浅回踩"的 FVG 从 CE_REACHED 降回 TOUCHED（扣分 −15 回升 −10）。
      let deepest = Infinity;
      for (let i = item.index + 1; i <= currentIndex; i++) {
        const candle = candles[i];
        deepest = Math.min(deepest, candle.low);
        const at = candle.closeTime ?? candle.time;
        if (firstTouchAt == null && candle.low <= item.top) firstTouchAt = at;
        if (ceReachedAt == null && candle.low <= mid) ceReachedAt = at;
        if (filledAt == null && candle.low <= item.bottom) filledAt = at;
        if (closeFilledAt == null && candle.close <= item.bottom) closeFilledAt = at;
      }
      if (deepest <= item.bottom) status = "FILLED"; // 触及远端 = 完全回补
      else if (deepest <= mid) status = "CE_REACHED"; // 触及中点
      else if (deepest <= item.top) status = "TOUCHED"; // 仅进入缺口（未到中点）
      let deepestClose = Infinity;
      for (let i = item.index + 1; i <= currentIndex; i++) deepestClose = Math.min(deepestClose, candles[i].close);
      if (deepestClose <= item.bottom) closeStatus = "FILLED";
      else if (deepestClose <= mid) closeStatus = "CE_REACHED";
      else if (deepestClose <= item.top) closeStatus = "TOUCHED";
    } else if (item.type === "BEARISH_FVG") {
      // P1：对称——消耗深度由整个形成后区间的最高 high 一次性决定
      let deepest = -Infinity;
      for (let i = item.index + 1; i <= currentIndex; i++) {
        const candle = candles[i];
        deepest = Math.max(deepest, candle.high);
        const at = candle.closeTime ?? candle.time;
        if (firstTouchAt == null && candle.high >= item.bottom) firstTouchAt = at;
        if (ceReachedAt == null && candle.high >= mid) ceReachedAt = at;
        if (filledAt == null && candle.high >= item.top) filledAt = at;
        if (closeFilledAt == null && candle.close >= item.top) closeFilledAt = at;
      }
      if (deepest >= item.top) status = "FILLED"; // 触及远端 = 完全回补
      else if (deepest >= mid) status = "CE_REACHED"; // 触及中点
      else if (deepest >= item.bottom) status = "TOUCHED"; // 仅进入缺口（未到中点）
      let deepestClose = -Infinity;
      for (let i = item.index + 1; i <= currentIndex; i++) deepestClose = Math.max(deepestClose, candles[i].close);
      if (deepestClose >= item.top) closeStatus = "FILLED";
      else if (deepestClose >= mid) closeStatus = "CE_REACHED";
      else if (deepestClose >= item.bottom) closeStatus = "TOUCHED";
    } else if (item.ict === true && item.lifecycleState) {
      // 严格 OB/Breaker 已按“确认后”逐根维护生命周期；这里不能把创建位移腿或普通触碰
      // 再次解释成 FILLED，否则会破坏 FRESH/失效/角色反转语义。
      status = item.lifecycleState;
    } else {
      for (let i = item.index + 1; i <= currentIndex; i++) {
        if (candles[i].low <= item.high && candles[i].high >= item.low) { status = "FILLED"; break; }
      }
    }
    const isFvg = item.type === "BULLISH_FVG" || item.type === "BEARISH_FVG";
    const executionStatus = isFvg && closeStatus !== "FILLED" && status === "FILLED" ? "WICK_FILLED" : closeStatus === "FILLED" ? "FILLED" : status;
    const fillType = !isFvg || status !== "FILLED" ? null : closeStatus === "FILLED" ? "CLOSE" : "WICK";
    const originRangeId = causalRangeId(item);
    const rangeMatch = !range?.rangeId ? null : !!originRangeId && originRangeId === range.rangeId;
    const provenanceStatus = !range?.rangeId ? "UNSCOPED" : rangeMatch ? "ACTIVE_RANGE" : originRangeId ? "STALE_RANGE" : "UNBOUND";
    const executable = requireRangeIdentity && range?.rangeId && !rangeMatch ? false : item.executable;
    return {
      ...item,
      location,
      age,
      status,
      originRangeId,
      rangeId: originRangeId,
      provenanceStatus,
      ...(executable === false ? { executable: false, rejectionReason: item.rejectionReason || "RANGE_IDENTITY_MISMATCH" } : {}),
      ...(isFvg ? { wickStatus: status, closeStatus, executionStatus, fillType, firstTouchAt, ceReachedAt, filledAt, closeFilledAt } : {}),
    };
  };

  return {
    fvg: (pdArray.fvg || []).map(annotate),
    ob: (pdArray.ob || []).map(annotate),
  };
}

/**
 * V1.6：PD Array Ranking（执行区域，不参与 bias）。
 * 规则：
 *   - 方向与 bias 相反 → Ignore（排除）
 *   - 执行参考价已经越过本轮 dealing range 的失效边界 → Ignore（到达它之前 Bias 已失效）
 *   - 同向且在顺位一侧（Bullish: DISCOUNT；Bearish: PREMIUM）→ VALID，进 Primary/Alternative
 *   - 同向但在逆位一侧 → COUNTER_LOCATION（低分，仅作备选展示）
 * 评分：同向 +60，顺位 +30，逆位 -20，已填充 -25。FVG 参考价=顺位侧端点（Bullish bottom / Bearish top），OB 同理。
 */
export function rankPDArray({ bias, range, pdArray }) {
  // 没有确认推动区间时，FVG/OB 仍保留为价格交付审计对象，但不得被 RECENT 的
  // 任意中点排成 Primary/Alternative 执行区。
  if (!range || range.rangeType === "RECENT" || range.rangeType === "NONE") return { primary: null, alternatives: [] };
  const eq = range && range.equilibrium;
  const rangeHigh = Number(range?.high);
  const rangeLow = Number(range?.low);
  const hasRangeBounds = Number.isFinite(rangeHigh) && Number.isFinite(rangeLow) && rangeHigh > rangeLow;
  const isBuyBias = bias === "BULLISH";
  const items = [...(pdArray.fvg || []), ...(pdArray.ob || [])];

  const candidates = [];
  for (const item of items) {
    if (range.rangeId && causalRangeId(item) !== range.rangeId) continue;
    if (item.direction !== bias) continue; // 反向 → Ignore

    // P1：FVG 触及远端（FILLED）＝缺口完全回补，彻底失效 → 不进入候选，
    // 不能成为 Primary/Alternative（否则已失效 FVG 仍被当作执行目标抬高 Confidence）。
    // 严格 OB/Breaker 的 INVALIDATED 已失效；非 ICT 历史对象也不能进入执行候选。
    if (item.type.includes("FVG") && (item.status === "FILLED" || item.executable === false)) continue;
    if (!item.type.includes("FVG") && (item.ict !== true || item.status === OB_LIFECYCLE.INVALIDATED || item.executable === false)) continue;

    const top = item.top ?? item.high; // OB 项用 high/low
    const bottom = item.bottom ?? item.low;
    // Bullish 阵列以 bottom 为计划执行参考；bottom 低于 range low 时，价格必须先跌破
    // 本轮保护边界才到达该阵列。Bearish 对称。此类旧阵列可留在原始审计数据中，
    // 但不能再进入当前 Primary/Alternative 或抬高置信度。
    const executionPrice = isBuyBias ? bottom : top;
    if (hasRangeBounds && (executionPrice < rangeLow || executionPrice > rangeHigh)) continue;
    const mid = (top + bottom) / 2;
    const loc = eq == null ? null : mid > eq ? "PREMIUM" : mid < eq ? "DISCOUNT" : "AT_EQ";
    const inFavor = isBuyBias ? loc === "DISCOUNT" : loc === "PREMIUM";

    let score = 60 + (inFavor ? 30 : -20);
    // P1：FVG 消耗分级扣分——FILLED（已触及远端）在 rankPDArray 已排除；
    // CE_REACHED（触及中点）/TOUCHED（进入未到中点）仍保留参考价值，按消耗程度扣分
    if (item.status === "FILLED") score -= 25; // 兼容旧 OB（严格 OB 不会产生 FILLED）
    else if (item.status === "CE_REACHED") score -= 15;
    else if (item.status === "TOUCHED" || item.status === "MITIGATED") score -= 10;
    if (item.age > 60) score -= 10; // 太旧的执行区价值低

    candidates.push({
      type: item.type,
      price: executionPrice,
      top,
      bottom,
      score,
      location: loc,
      status: inFavor ? "VALID" : "COUNTER_LOCATION",
      lifecycleState: item.lifecycleState ?? item.status,
      id: item.id ?? null,
      kind: item.kind ?? null,
      originRangeId: causalRangeId(item),
      structureEventId: item.structureEventId ?? null,
      displacementId: item.displacementId ?? null,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const primary = candidates.find((c) => c.status === "VALID") || null;
  const alternatives = candidates.filter((c) => c !== primary).map(({ type, price, top, bottom, location, status, lifecycleState, id, kind, originRangeId, structureEventId, displacementId }) => ({ type, price, top, bottom, location, status, lifecycleState, id, kind, originRangeId, structureEventId, displacementId }));

  return { primary, alternatives };
}
