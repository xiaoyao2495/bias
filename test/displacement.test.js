/**
 * displacement.test.js — 位移 K 检测（P1-C）
 *
 * 覆盖 findDisplacements：实体 ≥ 阈值倍 × 前 lookback 根平均实体 → 标记位移 K（UP/DOWN）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findDisplacements } from "../indicators/displacement.js";

const M5 = 300_000;
const now = Date.now();
/** 已收盘 5m K：open=100，body=|close-100| */
const k = (i, close, { closeTime } = {}) => ({
  time: i * M5,
  open: 100,
  high: Math.max(100, close) + 1,
  low: Math.min(100, close) - 1,
  close,
  closeTime: closeTime ?? now - (100 - i) * M5,
});

test("UP 位移：实体 ≥ 1.5× 前 20 根平均实体，close ≥ open", () => {
  const h5m = Array.from({ length: 21 }, (_, i) => k(i, i < 20 ? 101 : 105)); // 前 20 根 body=1，第 21 根 body=5
  const out = findDisplacements(h5m);
  assert.equal(out.length, 1);
  assert.equal(out[0].direction, "UP");
  assert.equal(out[0].body, 5);
  assert.equal(out[0].avgBody, 1);
  assert.equal(out[0].ratio, 5);
  assert.equal(out[0].close, 105);
});

test("DOWN 位移：大阴线实体 → direction DOWN", () => {
  const h5m = Array.from({ length: 21 }, (_, i) => k(i, i < 20 ? 101 : 95)); // body 5 向下
  const out = findDisplacements(h5m);
  assert.equal(out.length, 1);
  assert.equal(out[0].direction, "DOWN");
  assert.equal(out[0].ratio, 5);
});

test("未达阈值 → 空数组（全部均等实体）", () => {
  const h5m = Array.from({ length: 30 }, (_, i) => k(i, 101)); // 全部 body=1 → ratio 1 < 1.5
  assert.deepEqual(findDisplacements(h5m), []);
});

test("K 线数量不足 lookback → 空数组", () => {
  const h5m = Array.from({ length: 19 }, (_, i) => k(i, 101));
  assert.deepEqual(findDisplacements(h5m), []);
});

test("avgBody = 0（全部平盘）→ 跳过不报错", () => {
  const h5m = Array.from({ length: 25 }, (_, i) => k(i, 100)); // body=0，avgBody=0
  assert.deepEqual(findDisplacements(h5m), []);
});

test("多根位移 → 时间升序输出", () => {
  const h5m = Array.from({ length: 23 }, (_, i) => k(i, i < 20 ? 101 : 105)); // i=20、21、22 均 body=5
  const out = findDisplacements(h5m);
  assert.equal(out.length, 3);
  assert.ok(out[0].time < out[1].time && out[1].time < out[2].time);
  assert.equal(out[0].ratio, 5); // 首根 avgBody 纯基线 → ratio 恰为 5
  assert.ok(out[2].ratio < out[0].ratio); // 后续 avgBody 含前一根大实体 → ratio 衰减
});

test("进行中 K（closeTime 未来）不参与检测", () => {
  const h5m = [
    ...Array.from({ length: 21 }, (_, i) => k(i, i < 20 ? 101 : 105)),
    k(21, 105, { closeTime: now + M5 }), // 进行中，应被过滤
  ];
  const out = findDisplacements(h5m);
  assert.equal(out.length, 1); // 只有已收盘的第 21 根
});
