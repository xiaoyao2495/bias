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
  const s = detectSweeps(h5m, [{ type: "PDH", price: 105 }], [], 104); // 现价 104 < 105 已收回
  assert.equal(s.side, "BSL");
  assert.equal(s.type, "PDH");
  assert.equal(s.level, 105);
  assert.equal(s.sweptPrice, 106);
  assert.equal(s.realtime, true);
  assert.equal(s.key, `${h5m.at(-1).time}_BSL`);
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
  const s = detectSweeps([...bars, liveK(112, 113, 111, 112)], [], [{ type: "EQL", price: 111 }], 112);
  assert.equal(s.side, "SSL");
  assert.equal(s.type, "EQL");
  assert.equal(s.level, 111);
  assert.equal(s.sweptPrice, 110);
  assert.equal(s.close, 112);
  assert.equal(s.realtime, false);
  assert.equal(s.closedTime, bars[48].closeTime);
  assert.equal(s.key, `${bars[48].time}_SSL`);
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

test("刺破但未收回 → null（SSL 收盘仍在 level 下方，不算扫损）", () => {
  // 常态收盘 115 > 111（位未消费，专测"未收回"条件）
  const bars = Array.from({ length: 50 }, (_, i) => closedK(i, 114, 116, 113, 115));
  bars[48] = closedK(48, 113, 114, 108, 109); // low 108 < 111 但 close 109 < 111 → 未收回
  assert.equal(detectSweeps([...bars, liveK(109, 110, 108, 109)], [], [{ type: "EQL", price: 111 }], 109), null);
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
  const bars = Array.from({ length: 50 }, (_, i) => normal(i));
  bars[10] = closedK(10, 106, 107, 105, 106); // 历史已收盘在 105 上方（位已消费）
  const h5m = [...bars, liveK(101, 106, 100, 104)]; // 插针 106 后现价收回 104
  assert.equal(detectSweeps(h5m, [{ type: "PDH", price: 105 }], [], 104), null);
});

test("实时：SSL 已被历史收盘消费 → 插针不再报扫损", () => {
  const bars = Array.from({ length: 50 }, (_, i) => normal(i));
  bars[10] = closedK(10, 94, 95, 93, 94); // 历史已收盘在 95 下方（位已消费）
  const h5m = [...bars, liveK(100, 101, 94, 100)]; // 插针 94 后现价收回 100
  assert.equal(detectSweeps(h5m, [], [{ type: "PDL", price: 95 }], 100), null);
});

test("已收盘确认：BSL 已被历史收盘消费 → 不再报扫损", () => {
  const bars = Array.from({ length: 50 }, (_, i) => normal(i));
  bars[30] = closedK(30, 106, 107, 105, 106); // 位早已消费
  bars[48] = closedK(48, 100, 107, 99, 97); // 插针 K：high 107 > 105，close 97 < 105
  assert.equal(detectSweeps([...bars, liveK(98, 99, 97, 98)], [{ type: "EQH", price: 105 }], [], 98), null);
});

test("已收盘确认：SSL 已被历史收盘消费 → 不再报扫损", () => {
  const bars = Array.from({ length: 50 }, (_, i) => normal(i));
  bars[30] = closedK(30, 94, 95, 93, 94); // 位早已消费
  bars[48] = closedK(48, 113, 114, 90, 112); // 插针 K：low 90 < 95，close 112 > 95
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
