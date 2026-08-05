/**
 * mss 单元测试：MSS / BOS 检测（周期无关：4H / 5m 通用）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectStructureEvents, scanStructureEvents } from "../indicators/mss.js";
import { findSwings } from "../indicators/swing.js";

const now = Date.now();

/** 生成 K 线（close=open；pivot 判定只依赖 high/low，触发价由 price 参数传入） */
function mk(h, l, i, closed = true) {
  const o = (h + l) / 2;
  return { time: i, open: o, high: h, low: l, close: o, closeTime: closed ? now - 1 : now + 100000 };
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
  const r = detectStructureEvents(bullish, { price: 121 });
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
  const r = detectStructureEvents(bullish, { price: 107 });
  assert.equal(r.lastEvent.type, "MSS");
  assert.equal(r.lastEvent.direction, "DOWN");
  assert.equal(r.lastEvent.level, 108); // MSS 基准 = 最近 swing low，非 protectedLow
  assert.equal(r.structureStatus, "INVALIDATED");
  assert.equal(r.structureLayer.internal.lastLow.price, 108);
  assert.equal(r.structureLayer.internal.trend, "BULLISH");
  assert.equal(r.structureLayer.external.low, 99); // 最近 LL 启动点
});

test("BEARISH：跌破最近 Swing Low → BOS_DOWN", () => {
  const r = detectStructureEvents(bearish, { price: 109 });
  assert.equal(r.direction, "BEARISH");
  assert.equal(r.lastEvent.type, "BOS");
  assert.equal(r.lastEvent.direction, "DOWN");
  assert.equal(r.lastEvent.level, 110);
});

test("BEARISH：突破最近 Swing High（lastHigh）→ MSS_UP", () => {
  const r = detectStructureEvents(bearish, { price: 136 });
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
  const r = detectStructureEvents(data, { price: 111 });
  assert.equal(r.direction, "BULLISH");
  assert.equal(r.lastEvent.type, "MSS");
  assert.equal(r.lastEvent.direction, "DOWN");
  assert.equal(r.lastEvent.level, 112); // 最近 swing low，而非更早的 108
  assert.ok(r.structureLayer.internal.protectedLow < 112); // 保护位更深（不用于 MSS 触发）
});

test("NEUTRAL：结构未确认时突破 swing → BOS（方向建立第一迹象），不触发 MSS", () => {
  const r = detectStructureEvents(neutral, { price: 110 });
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
  const closed = detectStructureEvents(bullish, { price: 121 });
  assert.equal(closed.lastEvent.confirmed, true);

  // 进行中末根（closeTime 未来）：判定价=传入实时价，事件仅提示
  const inProgress = bullish.concat(mk(118, 117, 16, false));
  const r = detectStructureEvents(inProgress, { price: 121 });
  assert.equal(r.lastEvent.type, "BOS");
  assert.equal(r.lastEvent.confirmed, false);
  assert.equal(r.lastEvent.realtime, true);
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
