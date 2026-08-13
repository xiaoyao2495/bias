/**
 * displacement.test.js — 位移 K 检测（ICT 2022 三条件）
 *
 * 覆盖 findDisplacements：BODY（实体 ≥ 阈值倍 × 前 lookback 根平均实体）
 * + STRUCTURE BREAK（收盘越过最近 Swing High/Low）+ FVG（相邻同向缺口）三条件同时满足。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findDisplacements } from "../indicators/displacement.js";

const M5 = 300_000;
const now = Date.now();
/** 全字段 K：open/close 控制实体，high/low 控制 swing 与 FVG */
const k = (i, open, close, high, low, { closeTime } = {}) => ({
  time: i * M5,
  open,
  close,
  high,
  low,
  closeTime: closeTime ?? now - (300 - i) * M5,
});

/**
 * UP 场景：index 8 形成 Swing High 101.5（两侧更低）；10-19 低位整理（无新 swing high，
 * 且高点给 FVG 留出下沿）；index 20 大阳线 body=6 突破 101.5；index 21 小阳线构成 FVG。
 */
function upScenario() {
  const c = [];
  for (let i = 0; i < 20; i++) {
    if (i === 8) c.push(k(i, 99.5, 100.5, 101.5, 99.0)); // Swing High 101.5
    else if (i >= 10) c.push(k(i, 98.8, 99.8, 99.8, 98.7)); // 低位整理
    else c.push(k(i, 99.5, 100.5, 101.0, 99.0));
  }
  c.push(k(20, 100, 106, 106, 99.9)); // 位移大阳线：close 106 > 101.5
  c.push(k(21, 106, 106.4, 106.8, 105.8)); // 小阳线低点 105.8 > 邻居高点 → bullish FVG
  return c;
}

/** DOWN 场景：index 8 形成 Swing Low 98.5；index 20 大阴线 body=6 跌破；index 21 构成 bearish FVG */
function downScenario() {
  const c = [];
  for (let i = 0; i < 20; i++) {
    if (i === 8) c.push(k(i, 99.0, 98.5, 100.0, 98.5)); // Swing Low 98.5
    else if (i >= 10) c.push(k(i, 99.5, 100.5, 101.2, 100.0)); // 高位整理
    else c.push(k(i, 99.0, 100.0, 101.0, 99.0));
  }
  c.push(k(20, 100, 94, 100.2, 94)); // 位移大阴线：close 94 < 98.5
  c.push(k(21, 99.4, 99.4, 99.8, 99.0)); // 小阴线高点 99.8 < 邻居低点 → bearish FVG
  return c;
}

test("UP：BODY + STRUCTURE BREAK + FVG 三条件齐备 → 输出位移（含证据字段）", () => {
  const out = findDisplacements(upScenario());
  assert.equal(out.length, 1);
  assert.equal(out[0].direction, "UP");
  assert.equal(out[0].body, 6);
  assert.equal(out[0].ratio, 6); // 前 20 根 body 均 1 → avgBody=1
  assert.equal(out[0].close, 106);
  assert.equal(out[0].quality, "HIGH"); // ratio 6 ≥ 2 → 高质量位移
  // 结构突破：最近 Swing High 101.5（index 8）
  assert.deepEqual(out[0].structureBreak, { type: "BOS", direction: "UP", level: 101.5, swingIndex: 8 });
  // FVG 证据（位移 K 为第三根）：top = K20.low(99.9) > bottom = K18.high(99.8)，中间根 = 19
  assert.deepEqual(out[0].fvg, { top: 99.9, bottom: 99.8, middleIndex: 19 });
  assert.equal(out[0].time, now - (300 - 20) * M5);
});

test("DOWN：三条件齐备 → 跌破最近 Swing Low + bearish FVG", () => {
  const out = findDisplacements(downScenario());
  assert.equal(out.length, 1);
  assert.equal(out[0].direction, "DOWN");
  assert.equal(out[0].body, 6);
  assert.ok(out[0].ratio >= 5); // avgBody = (19×1 + 0.5)/20 = 0.975
  assert.equal(out[0].quality, "HIGH"); // ratio ≥ 2 → 高质量位移
  assert.deepEqual(out[0].structureBreak, { type: "BOS", direction: "DOWN", level: 98.5, swingIndex: 8 });
  // FVG 证据（位移 K 为中间根）：top = K19.low(100.0) > bottom = K21.high(99.8)，中间根 = 20
  assert.deepEqual(out[0].fvg, { top: 100.0, bottom: 99.8, middleIndex: 20 });
});

test("仅 BODY 达标、未破结构（close 未越过最近 Swing High）→ 空", () => {
  const c = [];
  for (let i = 0; i < 20; i++) {
    if (i === 8) c.push(k(i, 104, 105, 105.5, 103.5)); // Swing High 105.5
    else c.push(k(i, 103, 104, 104.5, 102.5));
  }
  c.push(k(20, 99, 104.2, 104.5, 98.8)); // body 5.2，但 close 104.2 < 105.5
  c.push(k(21, 104.2, 104.6, 105.0, 103.6));
  assert.deepEqual(findDisplacements(c), []);
});

test("BODY + BREAK 达标但无 FVG → 空", () => {
  const c = [];
  for (let i = 0; i < 20; i++) {
    if (i === 8) c.push(k(i, 103, 104, 103.5, 102.0)); // Swing High 103.5
    else c.push(k(i, 102, 103, 103.0, 101.0));
  }
  c.push(k(20, 100, 105, 105.5, 102.0)); // close 105 > 103.5 破结构，body 5
  c.push(k(21, 104.5, 104.8, 105.0, 102.5)); // 低点 102.5 ≤ 邻居高点 → 无缺口
  assert.deepEqual(findDisplacements(c), []);
});

test("K 线数量不足 lookback → 空数组", () => {
  const c = Array.from({ length: 19 }, (_, i) => k(i, 100, 101, 102, 99));
  assert.deepEqual(findDisplacements(c), []);
});

test("avgBody = 0（全部平盘）→ 跳过不报错", () => {
  const c = Array.from({ length: 25 }, (_, i) => k(i, 100, 100, 101, 99));
  assert.deepEqual(findDisplacements(c), []);
});

test("进行中 K（closeTime 未来）不参与检测", () => {
  const c = [...upScenario(), k(22, 106.5, 107, 107.5, 106.2, { closeTime: now + M5 })];
  const out = findDisplacements(c);
  assert.equal(out.length, 1); // 只有已收盘的位移 K
});

test("多根位移 → 时间升序输出（各自独立满足三条件）", () => {
  const c = upScenario();
  c.push(k(22, 106, 112, 112, 106)); // 第二根位移：body 6，close 112 > 101.5
  c.push(k(23, 112, 112.5, 113, 111.5)); // 低点 111.5 > 邻居高点 106.8 → FVG
  const out = findDisplacements(c);
  assert.equal(out.length, 2);
  assert.ok(out[0].time < out[1].time);
  assert.equal(out[0].direction, "UP");
  assert.equal(out[1].direction, "UP");
  assert.ok(out[0].ratio > out[1].ratio); // 第二根 avgBody 含第一根大实体 → ratio 衰减
  // 第二根位移 FVG（位移 K 为中间根）：top = K23.low(111.5) > bottom = K21.high(106.8)，中间根 = 22
  assert.deepEqual(out[1].fvg, { top: 111.5, bottom: 106.8, middleIndex: 22 });
});
