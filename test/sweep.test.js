/**
 * sweep.test.js — 流动性扫损检测（P1-A）
 *
 * 覆盖 detectSweeps 两个分支：
 *   实时（进行中 5m K 刺破 + 现价收回）与 已收盘确认（window 内刺破后收回，从近到远取最近）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectSweeps, isJudasWindow } from "../indicators/sweep.js";

const M5 = 300_000;
const now = Date.now();
/** 已收盘 5m K：closeTime 在过去 */
const closedK = (i, o, h, l, c) => ({ time: i * M5, open: o, high: h, low: l, close: c, closeTime: now - (60 - i) * M5 });
/** 进行中 5m K：closeTime 在未来 */
const liveK = (o, h, l, c) => ({ time: 999 * M5, open: o, high: h, low: l, close: c, closeTime: now + M5 });
const normal = (i) => closedK(i, 100, 101, 99, 100);

test("实时：BSL 被扫 — 进行中 K 刺破上方流动性且现价收回下方", () => {
  const h5m = [...Array.from({ length: 50 }, (_, i) => normal(i)), liveK(101, 106, 100, 104)];
  const s = detectSweeps(h5m, [{ type: "PDH", price: 105, time: 1234 }], [], 104); // 现价 104 < 105 已收回
  assert.equal(s.side, "BSL");
  assert.equal(s.type, "PDH");
  assert.equal(s.level, 105);
  assert.equal(s.sweptPrice, 106);
  assert.equal(s.realtime, true);
  assert.equal(s.key, `${h5m.at(-1).time}_BSL`);
  // 透传被扫流动性位的形成时间（PDH=昨日日 K 开盘）
  assert.equal(s.levelTime, 1234);
});

test("实时：SSL 被扫 — 进行中 K 刺破下方流动性且现价收回上方", () => {
  const h5m = [...Array.from({ length: 50 }, (_, i) => normal(i)), liveK(100, 101, 98, 101)];
  const s = detectSweeps(h5m, [], [{ type: "PDL", price: 99 }], 101); // 现价 101 > 99 已收回
  assert.equal(s.side, "SSL");
  assert.equal(s.type, "PDL");
  assert.equal(s.sweptPrice, 98);
  assert.equal(s.realtime, true);
});

test("已收盘确认：SSL — 最近 48 根内跌破 EQL 后收盘收回", () => {
  // 常态收盘 115 > 111（位未消费，保证扫损事件是新鲜的）
  const bars = Array.from({ length: 50 }, (_, i) => closedK(i, 114, 116, 113, 115));
  bars[48] = closedK(48, 113, 114, 110, 112); // 扫损 K：low 110 < 111，close 112 > 111
  const s = detectSweeps([...bars, liveK(112, 113, 111, 112)], [], [{ type: "EQL", price: 111, time: 5555 }], 112);
  assert.equal(s.side, "SSL");
  assert.equal(s.type, "EQL");
  assert.equal(s.level, 111);
  assert.equal(s.sweptPrice, 110);
  assert.equal(s.close, 112);
  assert.equal(s.realtime, false);
  assert.equal(s.closedTime, bars[48].closeTime);
  assert.equal(s.key, `${bars[48].time}_SSL`);
  // 透传被扫流动性位的形成时间（EQL=触点 swing 的 4H K 开盘）
  assert.equal(s.levelTime, 5555);
});

test("已收盘确认：BSL — 从近到远取最近一次事件", () => {
  const bars = Array.from({ length: 50 }, (_, i) => normal(i));
  bars[47] = closedK(47, 100, 107, 99, 98); // 更早的扫损 K
  bars[48] = closedK(48, 100, 109, 99, 97); // 更近的扫损 K
  const s = detectSweeps([...bars, liveK(98, 99, 97, 98)], [{ type: "EQH", price: 106 }], [], 98);
  assert.equal(s.type, "EQH");
  assert.equal(s.sweptPrice, 109); // 取最近一根（48）而非更早的（47）
  assert.equal(s.time, bars[48].time);
});

test("无事件 → null（价格未刺破流动性位）", () => {
  const h5m = [...Array.from({ length: 50 }, (_, i) => normal(i)), liveK(100, 101, 99, 100)];
  assert.equal(detectSweeps(h5m, [{ type: "PDH", price: 150 }], [{ type: "PDL", price: 50 }], 100), null);
});

test("刺破但未收回 → null（SSL 收盘仍在 level 下方，且次根也未收回，不算扫损）", () => {
  // 常态收盘 115 > 111（位未消费，专测"未收回"条件）
  const bars = Array.from({ length: 50 }, (_, i) => closedK(i, 114, 116, 113, 115));
  bars[48] = closedK(48, 113, 114, 108, 109); // low 108 < 111 但 close 109 < 111 → 未收回
  bars[49] = closedK(49, 110, 111, 109, 110); // 次根仍收在 111 下方 → 跨根也无收回
  assert.equal(detectSweeps([...bars, liveK(109, 110, 108, 109)], [], [{ type: "EQL", price: 111 }], 109), null);
});

test("V2.7 跨根收回：第一根刺破未收回，次根收回 → 报 SSL", () => {
  const bars = Array.from({ length: 50 }, (_, i) => closedK(i, 114, 116, 113, 115));
  bars[48] = closedK(48, 113, 114, 108, 109); // 刺破 111（low 108），close 109 未收回
  const s = detectSweeps([...bars, liveK(109, 110, 108, 109)], [], [{ type: "EQL", price: 111 }], 109);
  assert.equal(s.side, "SSL");
  assert.equal(s.level, 111);
  assert.equal(s.sweptPrice, 108); // 刺破 K 的极值
  assert.equal(s.close, 115); // 次根收回价
});

test("无 price → 跳过实时检测，只做已收盘确认", () => {
  // 常态收盘 115 > 111（位未消费）
  const bars = Array.from({ length: 50 }, (_, i) => closedK(i, 114, 116, 113, 115));
  bars[48] = closedK(48, 113, 114, 110, 112);
  const s = detectSweeps([...bars, liveK(112, 113, 111, 112)], [], [{ type: "EQL", price: 111 }]);
  assert.equal(s.side, "SSL");
  assert.equal(s.realtime, false);
});

// —— 回归：流动性位"已消费"检测（KORUUSDT 08-06 误报）——
// 位只要被历史任一已收盘 K 收在 level 外侧即视为已消费（已破位/被扫），
// 之后插针只是回测旧位，不算新扫损。只认收盘（wick 刺破不算消费）。

test("实时：BSL 已被历史收盘消费 → 插针不再报扫损", () => {
  // 历史已收盘全部在 105 上方（位已消费，且无跨根收回 → 不补报）
  const bars = Array.from({ length: 50 }, (_, i) => closedK(i, 106, 107, 105, 106));
  const h5m = [...bars, liveK(101, 106, 100, 104)]; // 插针 106 后现价收回 104
  assert.equal(detectSweeps(h5m, [{ type: "PDH", price: 105 }], [], 104), null);
});

test("实时：SSL 已被历史收盘消费 → 插针不再报扫损", () => {
  // 历史已收盘全部在 95 下方（位已消费，且无跨根收回 → 不补报）
  const bars = Array.from({ length: 50 }, (_, i) => closedK(i, 94, 95, 93, 94));
  const h5m = [...bars, liveK(100, 101, 94, 100)]; // 插针 94 后现价收回 100
  assert.equal(detectSweeps(h5m, [], [{ type: "PDL", price: 95 }], 100), null);
});

test("已收盘确认：BSL 已被历史收盘消费 → 不再报扫损", () => {
  const bars = Array.from({ length: 50 }, (_, i) => normal(i));
  bars[30] = closedK(30, 106, 107, 105, 106); // 位早已消费（收在上方）
  bars[31] = closedK(31, 106, 107, 105, 106); // 次根也收在上方 → bars[30] 无跨根收回
  bars[48] = closedK(48, 100, 107, 99, 97); // 插针 K：high 107 > 105，close 97 < 105（位已消费 → 不报）
  assert.equal(detectSweeps([...bars, liveK(98, 99, 97, 98)], [{ type: "EQH", price: 105 }], [], 98), null);
});

test("已收盘确认：位形成之前的历史收盘在外侧 → 不算消费，扫损仍上报", () => {
  // 位 time=20*M5 形成；bars[10]（time=10*M5，位形成前）收 106 在 105 上方，
  // 位形成后从未收在上方 → 位未消费 → 插针后收回应报 BSL（08/15 误吞修复回归）。
  const bars = Array.from({ length: 50 }, (_, i) => closedK(i, 100, 101, 99, 100));
  bars[10] = closedK(10, 106, 107, 105, 106); // 位形成前收在 105 上方（不算消费）
  bars[48] = closedK(48, 100, 107, 99, 97); // 插针 K：high 107 > 105，close 97 < 105 → 有效扫损
  const s = detectSweeps([...bars, liveK(98, 99, 97, 98)], [{ type: "PDH", price: 105, time: 20 * M5 }], [], 98);
  assert.equal(s.side, "BSL");
  assert.equal(s.level, 105);
  assert.equal(s.sweptPrice, 107);
});

test("已收盘确认：位形成之后收盘在外侧 → 已消费，插针不再报", () => {
  // bars[30]/bars[31]（time ≥ 位形成）收 106 在 105 上方且次根未收回 → 位形成后被消费
  const bars = Array.from({ length: 50 }, (_, i) => closedK(i, 100, 101, 99, 100));
  bars[30] = closedK(30, 106, 107, 105, 106); // 位形成后收在上方（消费，无收回 → 本身不算扫损）
  bars[31] = closedK(31, 106, 107, 105, 106); // 次根也收在上方 → bars[30] 无跨根收回
  bars[48] = closedK(48, 100, 107, 99, 97); // 插针后收回，但位已消费 → 不报
  assert.equal(detectSweeps([...bars, liveK(98, 99, 97, 98)], [{ type: "PDH", price: 105, time: 20 * M5 }], [], 98), null);
});

test("已收盘确认：SSL 已被历史收盘消费 → 不再报扫损", () => {
  const bars = Array.from({ length: 50 }, (_, i) => normal(i));
  bars[30] = closedK(30, 94, 95, 93, 94); // 位早已消费（收在下方）
  bars[31] = closedK(31, 94, 95, 93, 94); // 次根也收在下方 → bars[30] 无跨根收回
  bars[48] = closedK(48, 113, 114, 90, 112); // 插针 K：low 90 < 95，close 112 > 95（位已消费 → 不报）
  assert.equal(detectSweeps([...bars, liveK(112, 113, 111, 112)], [], [{ type: "PDL", price: 95 }], 112), null);
});

test("历史 wick 刺破但收盘未越过 → 不算消费，扫损仍上报", () => {
  const bars = Array.from({ length: 50 }, (_, i) => normal(i));
  bars[10] = closedK(10, 100, 106, 99, 100); // wick 到 106 但收 100（未消费）
  bars[48] = closedK(48, 100, 107, 99, 97); // 插针后收回 → 有效扫损
  const s = detectSweeps([...bars, liveK(98, 99, 97, 98)], [{ type: "EQH", price: 105 }], [], 98);
  assert.equal(s.side, "BSL");
  assert.equal(s.type, "EQH");
  assert.equal(s.level, 105);
  assert.equal(s.sweptPrice, 107);
});

test("detectSweeps: 透传盘前流动性位的形成日期（levelDate）", () => {
  // 常态收盘 100 > 99（未消费），48 号 K 刺破 106 后收盘收回 97 → BSL 扫损
  const bars = Array.from({ length: 50 }, (_, i) => normal(i));
  bars[48] = closedK(48, 100, 107, 99, 97);
  const s = detectSweeps([...bars, liveK(98, 99, 97, 98)], [{ type: "PRE_MARKET_HIGH", price: 106, date: "2026-08-09" }], [], 98);
  assert.equal(s.type, "PRE_MARKET_HIGH");
  assert.equal(s.levelDate, "2026-08-09");
});

test("detectSweeps: 流动性位无形成时间 → 不产生 levelTime/levelDate 字段", () => {
  const bars = Array.from({ length: 50 }, (_, i) => normal(i));
  bars[48] = closedK(48, 100, 107, 99, 97);
  const s = detectSweeps([...bars, liveK(98, 99, 97, 98)], [{ type: "EQH", price: 106 }], [], 98);
  assert.equal(s.type, "EQH");
  assert.equal(s.levelTime, undefined);
  assert.equal(s.levelDate, undefined);
});

// —— Judas Swing（ICT 2022）：NY Open 窗口判定 ——
// 窗口 = 美股开盘后 90 分钟（北京时间）：夏令时（4-10 月）21:30-23:00，冬令时 22:30-24:00

test("isJudasWindow: 夏令时 北京 21:35（2026-08 月中）→ true", () => {
  assert.equal(isJudasWindow(new Date("2026-08-08T13:35:00Z")), true); // 北京 21:35
});

test("isJudasWindow: 夏令时 北京 21:30 整 → true（含边界）", () => {
  assert.equal(isJudasWindow(new Date("2026-08-08T13:30:00Z")), true); // 北京 21:30
});

test("isJudasWindow: 夏令时 北京 23:00 → false（窗口已过）", () => {
  assert.equal(isJudasWindow(new Date("2026-08-08T15:00:00Z")), false); // 北京 23:00
});

test("isJudasWindow: 冬令时 北京 22:35（2026-01 月中）→ true", () => {
  assert.equal(isJudasWindow(new Date("2026-01-08T14:35:00Z")), true); // 北京 22:35
});

test("isJudasWindow: 冬令时 北京 22:15 → false（窗口未开始）", () => {
  assert.equal(isJudasWindow(new Date("2026-01-08T14:15:00Z")), false); // 北京 22:15
});

test("detectSweeps: 传入 bias 时返回 judas 字段（默认 false，不改变既有扫损行为）", () => {
  // 基础收盘 115 > 111（EQL 未消费），扫损 K 跌破后收回
  const bars = Array.from({ length: 50 }, (_, i) => closedK(i, 114, 116, 113, 115));
  bars[48] = closedK(48, 113, 114, 110, 112); // SSL 扫损：low 110 < 111，close 112 > 111
  const s = detectSweeps([...bars, liveK(112, 113, 111, 112)], [], [{ type: "EQL", price: 111 }], 112, 48, "BULLISH");
  assert.equal(s.side, "SSL");
  assert.equal(typeof s.judas, "boolean");
});

test("P1-4：历史扫损按事件 K 时间判断 Judas，不受程序运行时间影响", () => {
  const inside = Date.parse("2026-08-08T13:35:00Z"); // 北京 21:35，夏令时 NY Open
  const outside = Date.parse("2026-08-08T12:00:00Z"); // 北京 20:00
  const event = (time) => ({ time, open: 113, high: 114, low: 110, close: 112, closeTime: time + M5 });
  const level = [{ type: "EQL", price: 111 }];

  assert.equal(detectSweeps([event(inside)], [], level, undefined, 48, "BULLISH").judas, true);
  assert.equal(detectSweeps([event(outside)], [], level, undefined, 48, "BULLISH").judas, false);
});

test("P1-4：实时扫损同样按当前 5m K 开盘时间判断 Judas", () => {
  const inside = Date.parse("2026-08-12T13:35:00Z"); // 北京 21:35
  const k = { time: inside, open: 113, high: 114, low: 110, close: 112, closeTime: Date.now() + M5 };
  const s = detectSweeps([k], [], [{ type: "EQL", price: 111 }], 112, 48, "BULLISH");
  assert.equal(s.realtime, true);
  assert.equal(s.judas, true);
});
