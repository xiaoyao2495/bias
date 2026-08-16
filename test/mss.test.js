/**
 * mss 单元测试：MSS / BOS 检测（周期无关：4H / 5m 通用）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectStructureEvents, scanStructureEvents } from "../indicators/mss.js";
import { findDisplacements } from "../indicators/displacement.js";
import { findSwings } from "../indicators/swing.js";

const now = Date.now();

/** 生成 K 线（close=open；pivot 判定只依赖 high/low，触发价由 price 参数传入） */
function mk(h, l, i, closed = true) {
  const o = (h + l) / 2;
  return { time: i, open: o, high: h, low: l, close: o, closeTime: closed ? now - 1 : now + 100000 };
}

function withClosedPrice(candles, price) {
  const last = candles.at(-1);
  return [...candles, {
    time: Number(last.time) + 1,
    closeTime: now - 1,
    open: last.close,
    high: Math.max(last.close, price),
    low: Math.min(last.close, price),
    close: price,
  }];
}

// BULLISH 结构：LOW99(LL) → HIGH115(HH) → LOW108(HL) → HIGH120(HH)
const bullish = [
  mk(102, 100, 0), mk(102, 100, 1), mk(102, 99, 2), mk(102, 100, 3), mk(103, 101, 4),
  mk(108, 104, 5), mk(115, 109, 6), mk(113, 111, 7), mk(114, 112, 8), mk(112, 108, 9),
  mk(110, 109, 10), mk(111, 110, 11), mk(118, 114, 12), mk(120, 117, 13), mk(119, 118, 14),
  mk(118, 117, 15),
];

// BEARISH 结构：LOW118(LL) → HIGH135(HH) → LOW110(LL) → HIGH125(LH)
const bearish = [
  mk(121, 119, 0), mk(121, 119, 1), mk(120, 118, 2), mk(121, 119, 3), mk(122, 120, 4),
  mk(127, 123, 5), mk(135, 128, 6), mk(133, 131, 7), mk(134, 132, 8), mk(132, 110, 9),
  mk(131, 129, 10), mk(122, 120, 11), mk(124, 120, 12), mk(125, 122, 13), mk(124, 123, 14),
  mk(123, 122, 15),
];

// NEUTRAL：LOW99(LL) → HIGH110(HH) → LOW104(HL) → HIGH108(LH)
const neutral = [
  mk(102, 100, 0), mk(102, 100, 1), mk(102, 99, 2), mk(102, 100, 3), mk(103, 101, 4),
  mk(108, 104, 5), mk(110, 107, 6), mk(109, 106, 7), mk(108, 105, 8), mk(107, 104, 9),
  mk(106, 105, 10), mk(107, 106, 11), mk(107, 105, 12), mk(108, 106, 13), mk(107, 106, 14),
  mk(106, 105, 15),
];

test("BULLISH：突破最近 Swing High → BOS_UP（趋势延续，收盘确认）", () => {
  const r = detectStructureEvents(withClosedPrice(bullish, 121));
  assert.equal(r.direction, "BULLISH");
  assert.equal(r.structureStatus, "VALID");
  assert.equal(r.lastEvent.type, "BOS");
  assert.equal(r.lastEvent.direction, "UP");
  assert.equal(r.lastEvent.level, 120);
  assert.equal(r.lastEvent.confirmed, true);
  assert.equal(r.lastEvent.realtime, false);
  assert.equal(r.structureLayer.internal.lastHigh.price, 120);
});

test("BULLISH：跌破最近 Swing Low（lastLow）→ MSS_DOWN（趋势转移）", () => {
  const r = detectStructureEvents(withClosedPrice(bullish, 107));
  assert.equal(r.lastEvent.type, "MSS");
  assert.equal(r.lastEvent.direction, "DOWN");
  assert.equal(r.lastEvent.level, 108); // MSS 基准 = 最近 swing low，非 protectedLow
  assert.equal(r.lastEvent.semanticType, "STRUCTURE_BREAK");
  assert.equal(r.lastEvent.ictMss, false);
  assert.equal(r.structureStatus, "INVALIDATED");
  assert.equal(r.structureLayer.internal.lastLow.price, 108);
  assert.equal(r.structureLayer.internal.trend, "BULLISH");
  assert.equal(r.structureLayer.external.low, 99); // 最近 LL 启动点
});

test("BEARISH：跌破最近 Swing Low → BOS_DOWN", () => {
  const r = detectStructureEvents(withClosedPrice(bearish, 109));
  assert.equal(r.direction, "BEARISH");
  assert.equal(r.lastEvent.type, "BOS");
  assert.equal(r.lastEvent.direction, "DOWN");
  assert.equal(r.lastEvent.level, 110);
});

test("BEARISH：突破最近 Swing High（lastHigh）→ MSS_UP", () => {
  const r = detectStructureEvents(withClosedPrice(bearish, 136));
  assert.equal(r.lastEvent.type, "MSS");
  assert.equal(r.lastEvent.direction, "UP");
  assert.equal(r.lastEvent.level, 125); // MSS 基准 = 最近 swing high（LH），非 protectedHigh 135
  assert.equal(r.structureStatus, "INVALIDATED");
  assert.equal(r.structureLayer.internal.lastHigh.price, 125);
});

test("MSS 优先于更深的保护位：BULLISH 中最新 HL 后的 HH 场景（LL→HH→HL→HH→HL）", () => {
  // lastLow = HL(112) 在最后一个 HH 之后，跌破 112 即 MSS，而非更早的 protectedLow(108)
  const data = bullish.concat([
    mk(116, 112, 16), // 回撤低点 112 → HL（最近 swing low）
    mk(115, 113, 17), mk(115, 114, 18),
  ]);
  const r = detectStructureEvents(withClosedPrice(data, 111));
  assert.equal(r.direction, "BULLISH");
  assert.equal(r.lastEvent.type, "MSS");
  assert.equal(r.lastEvent.direction, "DOWN");
  assert.equal(r.lastEvent.level, 112); // 最近 swing low，而非更早的 108
  assert.ok(r.structureLayer.internal.protectedLow < 112); // 保护位更深（不用于 MSS 触发）
});

test("NEUTRAL：结构未确认时突破 swing → BOS（方向建立第一迹象），不触发 MSS", () => {
  const r = detectStructureEvents(withClosedPrice(neutral, 110));
  assert.equal(r.direction, "NEUTRAL");
  assert.equal(r.lastEvent.type, "BOS");
  assert.equal(r.lastEvent.direction, "UP");
  assert.equal(r.structureStatus, "VALID"); // NEUTRAL 无 MSS
});

test("价格在结构内 → 无事件", () => {
  const r = detectStructureEvents(bullish, { price: 112 });
  assert.equal(r.events.length, 0);
  assert.equal(r.lastEvent, null);
});

test("收盘确认：末根已收盘才 confirmed；进行中 K 传实时价 → 仅提示（realtime）", () => {
  // 已收盘末根（index 15 closeTime 过去）：判定用 close，事件 confirmed
  const closed = detectStructureEvents(withClosedPrice(bullish, 121));
  assert.equal(closed.lastEvent.confirmed, true);

  // 进行中末根（closeTime 未来）：判定价=传入实时价，事件仅提示
  const inProgress = bullish.concat(mk(118, 117, 16, false));
  const r = detectStructureEvents(inProgress, { price: 121 });
  assert.equal(r.lastEvent.type, "BOS");
  assert.equal(r.lastEvent.confirmed, false);
  assert.equal(r.lastEvent.realtime, true);
});

test("修复：进行中 K 不参与 swing 确认，swing 点不漂移", () => {
  // 基准：bullish 最后一个已确认 swing high = 120
  const rBase = detectStructureEvents(withClosedPrice(bullish, 121));
  assert.equal(rBase.structureLayer.internal.lastHigh.price, 120);

  // 追加两根进行中 K（closeTime 未来），其 high 极高（999/998）——
  // 若参与 Pivot 确认，旧逻辑会把 999 识别为 swing high（lastHigh=999），
  // BOS 判定随之失效；修复后只用已收盘 K，swing 稳定在 120。
  const live = bullish.concat(mk(999, 998, 16, false), mk(998, 997, 17, false));
  const rLive = detectStructureEvents(live, { price: 121 });
  assert.equal(rLive.structureLayer.internal.lastHigh.price, 120);
  assert.equal(rLive.structureLayer.internal.lastLow.price, 108);
  assert.equal(rLive.lastEvent.type, "BOS");
  assert.equal(rLive.lastEvent.direction, "UP");
  assert.equal(rLive.lastEvent.level, 120);
  assert.equal(rLive.lastEvent.confirmed, false); // 进行中 → 仅提示
  assert.equal(rLive.lastEvent.realtime, true);
});

test("修复：已收盘全部时行为不变（swing 正常确认）", () => {
  // 最后两根已收盘：index 15(118) < 14(119) 不构成 swing；lastHigh 仍 120
  const r = detectStructureEvents(withClosedPrice(bullish, 121));
  assert.equal(r.structureLayer.internal.lastHigh.price, 120);
  assert.equal(r.structureLayer.internal.lastLow.price, 108);
  assert.equal(r.lastEvent.type, "BOS");
  assert.equal(r.lastEvent.confirmed, true);
});

test("scanStructureEvents：历史扫描用收盘确认，wick 插针不算 MSS", () => {
  // BULLISH 后：index16 插针到 107（< 108）但 close 收回；index20 收盘 107 才确认 MSS
  const decline = [
    mk(117, 107, 16), // wick 插针破 108，close 112 收回，且不成新 swing
    mk(118, 111, 17),
    mk(115, 106, 18), // 与 index20 并列低点，避免确认成 swing
    mk(109, 108, 19), // close 108.5 > 108，仍未触发
    mk(108, 106, 20), // close 107 < 108 → MSS DOWN（收盘确认）
  ];
  const candles = bullish.concat(decline);
  const events = scanStructureEvents(candles, { lookback: 50 });

  // 事件必须全部 confirmed（收盘确认）
  assert.ok(events.length > 0);
  assert.ok(events.every((e) => e.confirmed === true));
  const mssDown = events.find((e) => e.type === "MSS" && e.direction === "DOWN");
  assert.ok(mssDown);
  // wick 插针（index 16）不产生 MSS，收盘确认的 MSS 从 index 20 开始
  assert.ok(mssDown.atIndex >= 20);
  // 时间升序
  for (let i = 1; i < events.length; i++) assert.ok(events[i - 1].time <= events[i].time);
});

test("Swing 窗口按周期：5m 用每侧 1 根（ICT 最小定义），4H 保持每侧 2 根", () => {
  // index 2 HIGH 110：1/1 有效（相邻 1,3 更低），2/2 无效（index 4 更高）；index 5 LOW 90 两者都有效
  const data = [
    mk(101, 100, 0), mk(100, 99, 1), mk(110, 108, 2), mk(109, 107, 3),
    mk(112, 111, 4), // 高于 110 → 2/2 下 index 2 不是 swing
    mk(105, 90, 5), mk(100, 95, 6), mk(102, 96, 7), mk(101, 97, 8),
  ];
  const w5 = findSwings(data, 1, 1); // 5m：每侧 1 根 → 识别 HIGH 110
  const w4h = findSwings(data, 2, 2); // 4H：每侧 2 根 → HIGH 110 被右侧第 2 根(112)否决
  assert.ok(w5.some((s) => s.type === "HIGH" && s.price === 110));
  assert.ok(!w4h.some((s) => s.type === "HIGH" && s.price === 110));
  assert.ok(w5.length > w4h.length);
});

test("P1 位移确认：突破腿为位移 K（大实体+突破+FVG）→ confirmedByDisplacement=true", () => {
  const tiny = { open: 100, close: 101, high: 102, low: 99 }; // 实体 1
  const data = [
    ...Array(16).fill(tiny),
    { open: 101, close: 101, high: 114, low: 109 }, // swing high 114
    tiny, tiny, tiny,
    { open: 105, close: 117, high: 118, low: 105 }, // 位移 K：实体 12、突破 114、FVG
    { open: 116, close: 117, high: 118, low: 115 }, // 收盘确认 K
  ].map((k, i) => ({ time: i, closeTime: now - 1, ...k }));
  const r = detectStructureEvents(data);
  assert.ok(r.lastEvent, "应触发 BOS");
  assert.equal(r.lastEvent.type, "BOS");
  assert.equal(r.lastEvent.confirmed, true);
  assert.equal(r.lastEvent.confirmedByDisplacement, true);
});

test("P1 位移确认：贴线突破（小实体，无位移）→ confirmedByDisplacement=false", () => {
  const tiny = { open: 100, close: 101, high: 102, low: 99 }; // 实体 1
  const data = [
    ...Array(16).fill(tiny),
    { open: 101, close: 101, high: 114, low: 109 }, // swing high 114
    tiny, tiny, tiny,
    { open: 113.5, close: 114.5, high: 115, low: 113 }, // 贴线突破：实体 1，close 114.5 刚过 114
    { open: 114, close: 114.5, high: 115, low: 113.5 },
  ].map((k, i) => ({ time: i, closeTime: now - 1, ...k }));
  const r = detectStructureEvents(data);
  assert.equal(r.lastEvent.confirmed, true);
  assert.equal(r.lastEvent.confirmedByDisplacement, false);
});

test("已收盘数组即使误传实时价，也只能按末根close判断，不能伪造confirmed事件", () => {
  const r = detectStructureEvents(bullish, { price: 999 });
  assert.equal(r.events.length, 0);
});

test("位移与FVG确认解耦：中间根位移当根确认结构事件，关联 FVG 等下一根且无前视", () => {
  const tiny = { open: 100, close: 101, high: 102, low: 99 }; // 实体 1
  const data = [
    ...Array(16).fill(tiny),
    { open: 101, close: 101, high: 114, low: 109 }, // swing high 114
    tiny, tiny, tiny,
    { open: 105, close: 117, high: 118, low: 100 }, // 位移 K（中间根）：实体 12、突破 114；low 100 不构成第三根 FVG
    { open: 116, close: 117, high: 118, low: 105 }, // FVG 确认 K：low 105 > idx19.high 102（bullishFvg 分支 2）
  ].map((k, i) => ({ time: i, closeTime: now - 1, ...k }));
  // 模拟 scanStructureEvents：完整数组预计算位移，再逐根切片传入（前视源）。
  // 位移 K 的 FVG 由下一根（confirmationIndex=21）确认。切片到 idx20 时 BOS 已因
  // displacement 成立，但不得提前携带尚未形成的 displacementFvg。
  const displacements = findDisplacements(data);
  const rPre = detectStructureEvents(data.slice(0, 21), { left: 1, right: 1, displacements });
  assert.equal(rPre.lastEvent.confirmed, true);
  assert.equal(rPre.lastEvent.confirmedByDisplacement, true, "位移在自身收盘确认，不依赖下一根 FVG");
  assert.equal(rPre.lastEvent.type, "BOS");
  assert.equal(rPre.lastEvent.semanticType, "BOS");
  assert.equal(rPre.lastEvent.displacementFvg, null, "第三根未到前不得读取未来 FVG");
  assert.equal(rPre.lastEvent.displacementConfirmationIndex, null);
  const rOk = detectStructureEvents(data, { left: 1, right: 1, displacements });
  assert.equal(rOk.lastEvent.confirmedByDisplacement, true);
  assert.deepEqual(rOk.lastEvent.displacementFvg, displacements.find((d) => d.index === 20).fvg);
  assert.equal(rOk.lastEvent.displacementConfirmationIndex, 21, "FVG 确认 K 到达后才附加关联区");
});

test("P1 位移确认：中间根位移（FVG 由下一根确认）且确认 K 收回 swing 内 → 位移 K 的 MSS 仍成立", () => {
  // BEARISH 结构（HH→LL→LH→LL，lastHigh=102）→ 位移 K（中间根：实体 4、close 104 突破 102，
  // low 100 不构成第三根 FVG，FVG 由下一根确认）→ 确认 K（low 100.5 > 前 high 99 构成 FVG 分支 2，
  // 但收盘 100.5 已收回 102 内）。位移与 MSS 都真实发生过，确认 K 收回 swing 内不得否决该事件。
  const tiny = { open: 100, close: 101, high: 102, low: 99 };
  const rows = [
    [100, 100, 100, 100], // 平盘
    [100, 105, 100, 105], // swing high 105 → HH
    [104, 104, 98, 100], // swing low 98 → LL
    [100, 100, 99, 100], // 确认 idx2 低点
    [100, 102, 99, 101], // swing high 102 → LH（MSS 参照）
    [98, 99, 97, 98], // swing low 97 → LL
    [100, 105, 100, 104], // 位移 K（中间根）：实体 4、close 104 > 102；high 105 与确认 K 等高 → 不构成 swing
    [101, 105, 100.5, 100.5], // FVG 确认 K：low 100.5 > idx5.high 99 → 分支 2 FVG；收盘 100.5 收回 102 内
  ];
  const data = [
    ...Array(16).fill(tiny),
    ...rows.map(([o, h, l, c]) => ({ open: o, high: h, low: l, close: c })),
  ].map((k, i) => ({ time: i, closeTime: now - 1, ...k }));
  // 实时检测：确认 K 已收盘但收回 swing 内 → 位移 K 的 MSS UP 必须仍成立（P1 修复点）
  const r = detectStructureEvents(data, { left: 1, right: 1 });
  assert.ok(r.lastEvent, "应触发事件");
  assert.equal(r.lastEvent.type, "MSS");
  assert.equal(r.lastEvent.direction, "UP");
  assert.equal(r.lastEvent.level, 102);
  assert.equal(r.lastEvent.price, 104, "价格应取位移 K 收盘价（突破发生时），而非收回的确认 K 收盘价");
  assert.equal(r.lastEvent.confirmedByDisplacement, true, "位移确认后不得因确认 K 收回 swing 内而否决");
  assert.equal(r.lastEvent.semanticType, "MSS");
  assert.equal(r.lastEvent.ictMss, true);
  // 历史扫描：事件应标在位移 K（closed index 22）而非确认 K，且为位移确认
  const events = scanStructureEvents(data, { lookback: 50, left: 1, right: 1 });
  const mssUp = events.find((e) => e.type === "MSS" && e.direction === "UP" && e.confirmedByDisplacement);
  assert.ok(mssUp, "历史扫描应包含位移确认的 MSS UP");
  assert.equal(mssUp.atIndex, 22, "事件应标在位移 K 而非确认 K");
});

test("P1: 去重保留首次突破时间（同 level 连续 MSS 不把事件起点推后，防伪造 Sweep→MSS 顺序）", () => {
  // BEARISH（lastHigh=102）→ 三根连续收盘突破 102（价格持续在 swing 外）→ 合并为一条 MSS：
  // atIndex/time 必须保留首次突破根（否则 time 被推到最后仍突破的根，opportunity 的
  // `e.time >= sweepTime` 会误判 Sweep 发生在 MSS 之前而生成 CHAIN）
  const tiny = { open: 100, close: 101, high: 102, low: 99 };
  const rows = [
    [100, 100, 100, 100],
    [100, 105, 100, 105], // swing high 105 → HH
    [104, 104, 98, 100], // swing low 98 → LL
    [100, 100, 99, 100], // 确认 idx2
    [100, 102, 99, 101], // swing high 102 → LH（MSS 参照 lastHigh=102）
    [98, 99, 97, 98], // swing low 97 → LL
    [100, 105, 100, 104], // 首次突破：close 104 > 102；high 105 与下根等高 → 不构成新 swing
    [101, 105, 101, 103], // 仍收在 102 外（close 103）
    [102, 104, 102, 102.5], // 仍收在 102 外（close 102.5）
  ];
  const data = [
    ...Array(16).fill(tiny),
    ...rows.map(([o, h, l, c]) => ({ open: o, high: h, low: l, close: c })),
  ].map((k, i) => ({ time: i, closeTime: now - 1, ...k }));
  const events = scanStructureEvents(data, { lookback: 50, left: 1, right: 1 });
  const mssUps = events.filter((e) => e.type === "MSS" && e.direction === "UP");
  assert.equal(mssUps.length, 1, "同 level 连续突破应合并为一条事件");
  assert.equal(mssUps[0].atIndex, 22, "事件起点保留首次突破根（不得被推后）");
  assert.equal(mssUps[0].time, data[22].closeTime, "time 保持首次突破时间");
  assert.equal(mssUps[0].lastSeenAt, 24, "持续状态记录最后仍突破的根");
});

test("首次普通收破后更晚才出现位移，不得事后把第一次结构破坏升级成MSS", () => {
  const tiny = { open: 100, close: 101, high: 102, low: 99 };
  const rows = [
    [100, 100, 100, 100], [100, 105, 100, 105], [104, 104, 98, 100],
    [100, 100, 99, 100], [100, 102, 99, 101], [98, 99, 97, 98],
    [101.5, 103, 101.5, 102.2], // 首次贴线收破 102，无位移
    [102.1, 103, 102, 102.3],
    [102, 108, 102, 107],       // 更晚的大实体位移
    [107, 108, 106, 107.5],
  ];
  const data = [...Array(16).fill(tiny), ...rows.map(([open, high, low, close]) => ({ open, high, low, close }))]
    .map((bar, i) => ({ time: i, closeTime: now - 1, ...bar }));
  const event = scanStructureEvents(data, { lookback: 50, left: 1, right: 1 })
    .find((item) => item.type === "MSS" && item.direction === "UP");
  assert.ok(event);
  assert.equal(event.atIndex, 22);
  assert.equal(event.confirmedByDisplacement, false);
  assert.equal(event.semanticType, "STRUCTURE_BREAK");
  assert.equal(event.laterDisplacementAt, 24);
});
