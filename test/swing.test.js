/**
 * swing/structure 单元测试：摆动点识别、HH/HL/LH/LL、结构判定
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findSwings, analyzeSwings } from "../indicators/swing.js";
import { judgeStructure, buildStructure } from "../indicators/structure.js";

function candle(high, low, i) {
  return { time: i, open: (high + low) / 2, high, low, close: (high + low) / 2, closeTime: 0 };
}

test("findSwings: 识别 Swing High / Swing Low", () => {
  const highs = [10, 11, 13, 12, 11, 10, 12, 14, 13, 12];
  const lows = [8, 9, 10, 9, 8, 7, 9, 10, 9, 8];
  const candles = highs.map((h, i) => candle(h, lows[i], i));

  const swings = findSwings(candles);
  assert.deepEqual(
    swings.map((s) => [s.type, s.price, s.index]),
    [
      ["HIGH", 13, 2],
      ["LOW", 7, 5],
      ["HIGH", 14, 7],
    ]
  );
});

test("analyzeSwings: 上涨结构打出 HH / HL", () => {
  const swings = [
    { type: "LOW", price: 90, index: 2 },
    { type: "HIGH", price: 100, index: 7 },
    { type: "LOW", price: 95, index: 12 },
    { type: "HIGH", price: 112, index: 17 },
    { type: "LOW", price: 107, index: 22 },
    { type: "HIGH", price: 118, index: 27 },
  ];
  const labels = analyzeSwings(swings).map((s) => s.label);
  assert.deepEqual(labels, ["LL", "HH", "HL", "HH", "HL", "HH"]);
});

test("judgeStructure: BULLISH / BEARISH / NEUTRAL", () => {
  const mk = (type, label, price) => ({ type, label, price, index: 0 });

  assert.equal(
    judgeStructure([mk("HIGH", "HH"), mk("LOW", "HL"), mk("HIGH", "HH"), mk("LOW", "HL")]),
    "BULLISH"
  );
  assert.equal(
    judgeStructure([mk("LOW", "HL"), mk("HIGH", "HH"), mk("LOW", "HL")]),
    "BULLISH"
  );
  assert.equal(
    judgeStructure([mk("HIGH", "LH"), mk("LOW", "LL"), mk("HIGH", "LH"), mk("LOW", "LL")]),
    "BEARISH"
  );
  assert.equal(judgeStructure([mk("HIGH", "HH"), mk("LOW", "LL")]), "NEUTRAL");
  assert.equal(judgeStructure([mk("HIGH", "HH")]), "NEUTRAL");
});

test("buildStructure: direction / sequence / protectedLow / external 位", () => {
  const labeled = [
    { type: "LOW", price: 90, index: 2, label: "LL" },
    { type: "HIGH", price: 100, index: 7, label: "HH" },
    { type: "LOW", price: 95, index: 12, label: "HL" },
    { type: "HIGH", price: 112, index: 17, label: "HH" },
    { type: "LOW", price: 107, index: 22, label: "HL" },
  ];
  const s = buildStructure(labeled);
  assert.equal(s.direction, "BULLISH");
  // V1.4：保护位 = 最后一个 HH(112) 之前的最近 LOW = 95（推动位移的低点），不是最近回撤 107
  assert.equal(s.protectedLow, 95);
  assert.equal(s.protectedHigh, null);
  assert.deepEqual(s.protectedLowInfo, { invalidationType: "STRUCTURE_PROTECTED_LOW", source: "HL_BEFORE_DISPLACEMENT" });
  assert.deepEqual(s.sequence, ["LL", "HH", "HL", "HH", "HL"]);
  // 外部：最近 LL=90，LL 之前无高点 → 无外部高点可比较 → 视为 EXTERNAL
  assert.equal(s.externalSwingLow, 90);
  assert.equal(s.externalSwingHigh, null);
  assert.equal(s.type, "EXTERNAL_BULLISH");
});

test("buildStructure: BEARISH 保护高点 = 最后一个 LL 之前的最近 HIGH", () => {
  const labeled = [
    { type: "HIGH", price: 200, index: 2, label: "HH" },
    { type: "LOW", price: 180, index: 7, label: "LL" },
    { type: "HIGH", price: 185, index: 12, label: "LH" },
    { type: "LOW", price: 160, index: 17, label: "LL" },
    { type: "HIGH", price: 170, index: 22, label: "LH" },
  ];
  const s = buildStructure(labeled);
  assert.equal(s.direction, "BEARISH");
  // 最后一个 LL(160) 之前的最近 HIGH = LH(185)（推动下跌位移的高点），不是最近 LH(170)
  assert.equal(s.protectedHigh, 185);
  assert.equal(s.protectedLow, null);
  assert.deepEqual(s.protectedHighInfo, { invalidationType: "STRUCTURE_PROTECTED_HIGH", source: "LH_BEFORE_DISPLACEMENT" });
});

test("buildStructure: 未突破外部高点 → INTERNAL_BULLISH", () => {
  const labeled = [
    { type: "LOW", price: 100, index: 2, label: "LL", time: 2 },
    { type: "HIGH", price: 112, index: 7, label: "HH", time: 7 }, // 外部高点 112
    { type: "LOW", price: 95, index: 12, label: "LL", time: 12 }, // 外部启动点
    { type: "HIGH", price: 105, index: 17, label: "LH", time: 17 },
    { type: "LOW", price: 98, index: 22, label: "HL", time: 22 },
    { type: "HIGH", price: 108, index: 27, label: "HH", time: 27 }, // 108 < 112，未突破外部高点
    { type: "LOW", price: 103, index: 32, label: "HL", time: 32 },
  ];
  const s = buildStructure(labeled);
  assert.equal(s.direction, "BULLISH");
  assert.equal(s.externalSwingHigh, 112); // 最近 LL(95) 之前的最近高点
  assert.equal(s.externalSwingLow, 95);
  assert.equal(s.type, "INTERNAL_BULLISH");
  // 外部结构位形成时间（swing 所在 4H K 开盘，扫损消息"被扫的流动性是什么时候的"）
  assert.equal(s.externalSwingHighTime, 7);
  assert.equal(s.externalSwingLowTime, 12);
});
