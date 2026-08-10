/**
 * structure.js — Structure 判断
 *
 * 判定规则（ICT 简化版，V1.1）：
 *   direction（方向判断不变）：
 *     BULLISH : 最近一个 Swing High = HH 且 最近一个 Swing Low = HL
 *     BEARISH : 最近一个 Swing High = LH 且 最近一个 Swing Low = LL
 *     NEUTRAL : 其他
 *
 *   type（Internal / External，审计用）：
 *     ICT 中 Daily Bias 更关注 HTF External Structure。
 *     - EXTERNAL_BULLISH : 多头结构且最近 High 已突破外部关键高点
 *     - INTERNAL_BULLISH : 多头结构但仍在外部高点下方（区间内部）
 *     - EXTERNAL_BEARISH / INTERNAL_BEARISH : 对称
 *     - RANGE : 无方向
 *
 *   externalSwingHigh / externalSwingLow：外部结构关键位（V1 只输出，不参与判定）
 *     - BULLISH：外部启动点 = 最近一个 LL（结构启动前的低点），
 *                外部高点   = 该 LL 之前最近的高点
 *     - BEARISH：对称
 *
 *   protectedLow / protectedHigh：失效位（V1.4：结构保护位，非任意 swing）
 *     - BULLISH : 最后一个 HH 之前的最近 LOW（推动该 HH 位移的起点低点），
 *                 source = "HL_BEFORE_DISPLACEMENT"（HL）或 "EXTERNAL_STRUCTURE_LOW"（LL）
 *     - BEARISH: 对称（最后一个 LL 之前的最近 HIGH，source = LH_BEFORE_DISPLACEMENT / EXTERNAL_STRUCTURE_HIGH）
 */

/**
 * @param {Array} labeled analyzeSwings() 的输出（含 label 字段）
 * @returns {"BULLISH"|"BEARISH"|"NEUTRAL"}
 */
export function judgeStructure(labeled) {
  let lastHigh = null;
  let lastLow = null;

  for (const s of labeled) {
    if (s.type === "HIGH") lastHigh = s;
    else lastLow = s;
  }

  if (lastHigh && lastLow) {
    if (lastHigh.label === "HH" && lastLow.label === "HL") return "BULLISH";
    if (lastHigh.label === "LH" && lastLow.label === "LL") return "BEARISH";
  }
  return "NEUTRAL";
}

/**
 * 组装完整的 Structure 结果：
 *   direction      : BULLISH / BEARISH / NEUTRAL
 *   type           : EXTERNAL_BULLISH / INTERNAL_BULLISH / EXTERNAL_BEARISH / INTERNAL_BEARISH / RANGE
 *   sequence       : 最近 N 个 label（HH/HL/LH/LL）
 *   protectedLow   : BULLISH 失效位（最近 HL 价位）
 *   protectedHigh  : BEARISH 失效位（最近 LH 价位）
 *   externalSwingHigh / externalSwingLow : 外部关键位（审计用）
 */
export function buildStructure(labeled, sequenceLength = 5) {
  const direction = judgeStructure(labeled);
  const lastHigh = lastByType(labeled, "HIGH");
  const lastLow = lastByType(labeled, "LOW");

  // V1.4：结构保护位（导致位移的低点/高点），不是任意 swing
  const pl = direction === "BULLISH" ? findProtectedLow(labeled) : null;
  const ph = direction === "BEARISH" ? findProtectedHigh(labeled) : null;

  const ext = findExternalLevels(labeled, direction);
  const type = classifyStructure(direction, lastHigh, lastLow, ext);

  return {
    direction,
    type,
    sequence: labeled.map((s) => s.label).slice(-sequenceLength),
    lastHigh,
    lastLow,
    protectedLow: pl ? pl.price : null,
    protectedHigh: ph ? ph.price : null,
    protectedLowInfo: pl ? { invalidationType: "STRUCTURE_PROTECTED_LOW", source: pl.source } : null,
    protectedHighInfo: ph ? { invalidationType: "STRUCTURE_PROTECTED_HIGH", source: ph.source } : null,
    externalSwingHigh: ext.high,
    externalSwingLow: ext.low,
    ...(ext.highIndex != null ? { externalSwingHighIndex: ext.highIndex } : {}),
    ...(ext.lowIndex != null ? { externalSwingLowIndex: ext.lowIndex } : {}),
    // 外部结构位形成时间（swing 所在 4H K 的开盘时间；labeled 无 time 时省略）：扫损消息"被扫的流动性是什么时候的"
    ...(ext.highTime != null ? { externalSwingHighTime: ext.highTime } : {}),
    ...(ext.lowTime != null ? { externalSwingLowTime: ext.lowTime } : {}),
  };
}

/**
 * V1.4 结构保护低点：最后一个 HH 之前的最近 LOW（推动该 HH 位移的起点低点）。
 * 跌破它 → 多头结构失效。source 用于审计：
 *   - 该 LOW 是 HL（位移前回撤低点）→ "HL_BEFORE_DISPLACEMENT"
 *   - 该 LOW 是 LL（外部启动点突破）→ "EXTERNAL_STRUCTURE_LOW"
 */
function findProtectedLow(labeled) {
  let hhIdx = -1;
  for (let i = labeled.length - 1; i >= 0; i--) {
    if (labeled[i].type === "HIGH" && labeled[i].label === "HH") {
      hhIdx = i;
      break;
    }
  }
  if (hhIdx === -1) return null;

  for (let i = hhIdx - 1; i >= 0; i--) {
    if (labeled[i].type === "LOW") {
      const low = labeled[i];
      return {
        price: low.price,
        source: low.label === "LL" ? "EXTERNAL_STRUCTURE_LOW" : "HL_BEFORE_DISPLACEMENT",
      };
    }
  }
  return null;
}

/** V1.4 结构保护高点：最后一个 LL 之前的最近 HIGH（对称） */
function findProtectedHigh(labeled) {
  let llIdx = -1;
  for (let i = labeled.length - 1; i >= 0; i--) {
    if (labeled[i].type === "LOW" && labeled[i].label === "LL") {
      llIdx = i;
      break;
    }
  }
  if (llIdx === -1) return null;

  for (let i = llIdx - 1; i >= 0; i--) {
    if (labeled[i].type === "HIGH") {
      const high = labeled[i];
      return {
        price: high.price,
        source: high.label === "HH" ? "EXTERNAL_STRUCTURE_HIGH" : "LH_BEFORE_DISPLACEMENT",
      };
    }
  }
  return null;
}

/**
 * V1.4.1 保护位实时校验（Protected Structure Validation）：
 * 价格已穿透保护位 → 结构立即视为失效（swing 确认滞后于实时价格的问题兜底）。
 *   BULLISH : price <= protectedLow  → INVALIDATED（跌破保护低点）
 *   BEARISH : price >= protectedHigh → INVALIDATED（突破保护高点）
 *   其他/无保护位/无价格 → VALID
 */
export function validateProtectedStructure(structure, price) {
  if (price == null) return { status: "VALID", brokenLevel: null };

  if (structure.direction === "BULLISH" && structure.protectedLow != null) {
    if (price <= structure.protectedLow) return { status: "INVALIDATED", brokenLevel: structure.protectedLow };
    return { status: "VALID", brokenLevel: null };
  }
  if (structure.direction === "BEARISH" && structure.protectedHigh != null) {
    if (price >= structure.protectedHigh) return { status: "INVALIDATED", brokenLevel: structure.protectedHigh };
    return { status: "VALID", brokenLevel: null };
  }
  return { status: "VALID", brokenLevel: null };
}

/** 寻找外部结构关键位（返回 price + 形成时间，时间来自 swing 的 time 字段） */
function findExternalLevels(labeled, direction) {
  if (direction === "BULLISH") {
    // 外部启动点 = 最近一个 LL（下跌阶段的最后低点）
    let lowIdx = -1;
    for (let i = labeled.length - 1; i >= 0; i--) {
      if (labeled[i].type === "LOW" && labeled[i].label === "LL") {
        lowIdx = i;
        break;
      }
    }
    if (lowIdx === -1) return { high: null, low: null };
    let highSwing = null;
    for (let i = lowIdx - 1; i >= 0; i--) {
      if (labeled[i].type === "HIGH") {
        highSwing = labeled[i];
        break;
      }
    }
    return {
      high: highSwing ? highSwing.price : null,
      highTime: highSwing ? highSwing.time : null,
      highIndex: highSwing ? highSwing.index : null,
      low: labeled[lowIdx].price,
      lowTime: labeled[lowIdx].time,
      lowIndex: labeled[lowIdx].index,
    };
  }

  if (direction === "BEARISH") {
    // 外部启动点 = 最近一个 LH（上涨阶段的最后高点）
    let highIdx = -1;
    for (let i = labeled.length - 1; i >= 0; i--) {
      if (labeled[i].type === "HIGH" && labeled[i].label === "LH") {
        highIdx = i;
        break;
      }
    }
    if (highIdx === -1) return { high: null, low: null };
    let lowSwing = null;
    for (let i = highIdx - 1; i >= 0; i--) {
      if (labeled[i].type === "LOW") {
        lowSwing = labeled[i];
        break;
      }
    }
    return {
      high: labeled[highIdx].price,
      highTime: labeled[highIdx].time,
      highIndex: labeled[highIdx].index,
      low: lowSwing ? lowSwing.price : null,
      lowTime: lowSwing ? lowSwing.time : null,
      lowIndex: lowSwing ? lowSwing.index : null,
    };
  }

  return { high: null, low: null };
}

/** 区分 Internal / External */
function classifyStructure(direction, lastHigh, lastLow, ext) {
  if (direction === "BULLISH") {
    const brokeExternal = ext.high == null || lastHigh.price > ext.high;
    return brokeExternal ? "EXTERNAL_BULLISH" : "INTERNAL_BULLISH";
  }
  if (direction === "BEARISH") {
    const brokeExternal = ext.low == null || lastLow.price < ext.low;
    return brokeExternal ? "EXTERNAL_BEARISH" : "INTERNAL_BEARISH";
  }
  return "RANGE";
}

function lastByType(labeled, type) {
  for (let i = labeled.length - 1; i >= 0; i--) {
    if (labeled[i].type === type) return labeled[i];
  }
  return null;
}
