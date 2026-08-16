/**
 * ICT 2022 核心价格模型的确定性随机不变量测试。
 *
 * 单个 test 内重复大量不同价格尺度/波动率场景，避免只在手写 BTC 价位 fixture 上通过。
 * 使用固定种子，失败可以稳定复现。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyDealingRangeLiquidity,
  isLiquidityTakenByClose,
  liquidityStateForLevel,
  rankLiquidityTargets,
} from "../indicators/liquidity.js";
import { findFvgs } from "../indicators/pdArray.js";
import { findDisplacements } from "../indicators/displacement.js";

function rng(seed = 0x2022) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function mirrorCandle(k, axis) {
  return {
    ...k,
    open: axis - k.open,
    close: axis - k.close,
    high: axis - k.low,
    low: axis - k.high,
  };
}

test("随机 500 组：BSL/SSL 的 close 消耗规则严格多空镜像，且 exact close 计为已拿走", () => {
  const random = rng(0xb51);
  for (let i = 0; i < 500; i++) {
    const level = 10 ** (-3 + random() * 8);
    const delta = level * (0.00001 + random() * 0.02);
    assert.equal(isLiquidityTakenByClose(level, level, true), true);
    assert.equal(isLiquidityTakenByClose(level, level, false), true);
    assert.equal(isLiquidityTakenByClose(level + delta, level, true), true);
    assert.equal(isLiquidityTakenByClose(level - delta, level, true), false);
    assert.equal(isLiquidityTakenByClose(level - delta, level, false), true);
    assert.equal(isLiquidityTakenByClose(level + delta, level, false), false);

    const activeFrom = 100;
    const buy = liquidityStateForLevel({ price: level, activeFrom }, true, [
      { high: level + delta, low: level - delta, close: level - delta, closeTime: 100 }, // 生效前/同时不得回看
      { high: level + delta, low: level - delta, close: level - delta, closeTime: 101 }, // wick raid
      { high: level + delta, low: level - delta, close: level, closeTime: 102 }, // close delivery
    ]);
    const sell = liquidityStateForLevel({ price: level, activeFrom }, false, [
      { high: level + delta, low: level - delta, close: level + delta, closeTime: 100 },
      { high: level + delta, low: level - delta, close: level + delta, closeTime: 101 },
      { high: level + delta, low: level - delta, close: level, closeTime: 102 },
    ]);
    assert.deepEqual(buy, { state: "BROKEN", brokenAt: 102, sweptAt: 101 });
    assert.deepEqual(sell, { state: "BROKEN", brokenAt: 102, sweptAt: 101 });
  }
});

test("随机 300 组：动态 Draw 在低价/高价品种均无 NaN、只选择方向侧有效目标", () => {
  const random = rng(0xd01);
  for (let i = 0; i < 300; i++) {
    const price = 10 ** (-4 + random() * 9);
    const span = price * (0.01 + random() * 0.3);
    const liquidity = {
      externalRange: { high: price + span, low: Math.max(Number.EPSILON, price - span) },
      buySide: [
        { type: "EXTERNAL_HIGH", price: price + span, rangeClass: "ERL", state: "ACTIVE", activeFrom: 10 },
        { type: "EQH", price: price + span * 0.4, rangeClass: "IRL", state: "ACTIVE", activeFrom: 20 },
        { type: "PDH", price: price - span * 0.2, rangeClass: "IRL", state: "ACTIVE", activeFrom: 30 }, // 错误方向
      ],
      sellSide: [
        { type: "EXTERNAL_LOW", price: price - span, rangeClass: "ERL", state: "ACTIVE", activeFrom: 10 },
        { type: "EQL", price: price - span * 0.4, rangeClass: "IRL", state: "ACTIVE", activeFrom: 20 },
        { type: "PDL", price: price + span * 0.2, rangeClass: "IRL", state: "ACTIVE", activeFrom: 30 }, // 错误方向
      ],
      internalRange: [],
    };
    const bullish = rankLiquidityTargets(null, liquidity, "BULLISH", price);
    const bearish = rankLiquidityTargets(null, liquidity, "BEARISH", price);
    assert.ok(bullish.primary.price > price);
    assert.ok(bearish.primary.price < price);
    for (const target of [bullish.primary, ...bullish.alternatives, bearish.primary, ...bearish.alternatives]) {
      assert.equal(Number.isFinite(target.score), true);
      assert.equal(Number.isFinite(target.price), true);
    }
    assert.deepEqual(rankLiquidityTargets(null, liquidity, "BULLISH", price), bullish, "评分必须确定性");
  }
});

test("随机 250 组：同一 dealing range 的 ERL/IRL 分类稳定，FVG 永不混入 stop sweep 池", () => {
  const random = rng(0xe21);
  for (let i = 0; i < 250; i++) {
    const low = 10 ** (-3 + random() * 7);
    const width = low * (0.05 + random() * 0.8);
    const high = low + width;
    const mid = (low + high) / 2;
    const out = applyDealingRangeLiquidity({
      liquidity: {
        buySide: [{ type: "PDH", price: mid + width * 0.1 }],
        sellSide: [{ type: "PDL", price: mid - width * 0.1 }],
      },
      range: { low, high, lowIndex: 0, highIndex: 1, rangeType: "RANDOM" },
      swings: [
        { type: "HIGH", price: mid + width * 0.2, index: 2, time: 2 },
        { type: "LOW", price: mid - width * 0.2, index: 3, time: 3 },
      ],
      fvgs: [{ type: "BULLISH_FVG", bottom: mid - width * 0.05, top: mid + width * 0.05, executable: true }],
      price: mid,
    });
    assert.equal(out.externalRange.high, high);
    assert.equal(out.externalRange.low, low);
    assert.equal(out.buySide.find((x) => x.type === "EXTERNAL_HIGH").rangeClass, "ERL");
    assert.equal(out.sellSide.find((x) => x.type === "EXTERNAL_LOW").rangeClass, "ERL");
    assert.equal(out.buySide.find((x) => x.type === "INTERNAL_HIGH").rangeClass, "IRL");
    assert.equal(out.sellSide.find((x) => x.type === "INTERNAL_LOW").rangeClass, "IRL");
    assert.equal(out.buySide.some((x) => x.type === "INTERNAL_FVG"), false);
    assert.equal(out.sellSide.some((x) => x.type === "INTERNAL_FVG"), false);
    assert.equal(out.internalRange.some((x) => x.type === "INTERNAL_FVG" && x.liquidityKind === "IMBALANCE"), true);
  }
});

test("随机 300 组：三根 K 的 bullish/bearish FVG 几何定义严格镜像", () => {
  const random = rng(0xf6a);
  for (let i = 0; i < 300; i++) {
    const base = 10 ** (-3 + random() * 7);
    const unit = base * (0.001 + random() * 0.02);
    const rows = [
      { time: 0, open: base - unit, high: base, low: base - 2 * unit, close: base - 0.5 * unit, closeTime: 1 },
      { time: 1, open: base, high: base + 8 * unit, low: base - unit, close: base + 7 * unit, closeTime: 2 },
      { time: 2, open: base + 6 * unit, high: base + 9 * unit, low: base + 3 * unit, close: base + 8 * unit, closeTime: 3 },
    ];
    const bullish = findFvgs(rows);
    assert.equal(bullish.length, 1);
    assert.equal(bullish[0].type, "BULLISH_FVG");
    const axis = 4 * base;
    const mirrored = findFvgs(rows.map((k) => mirrorCandle(k, axis)));
    assert.equal(mirrored.length, 1);
    assert.equal(mirrored[0].type, "BEARISH_FVG");
    assert.ok(Math.abs(mirrored[0].top - (axis - bullish[0].bottom)) <= Math.abs(axis) * 1e-12);
    assert.ok(Math.abs(mirrored[0].bottom - (axis - bullish[0].top)) <= Math.abs(axis) * 1e-12);
    assert.equal(mirrored[0].middleIndex, bullish[0].middleIndex);
    assert.equal(mirrored[0].confirmedAt, bullish[0].confirmedAt);
  }
});

test("随机 200 组：位移要求实体占比与推动端收盘，多空镜像且长影线不会误报", () => {
  const random = rng(0xd15);
  for (let scenario = 0; scenario < 200; scenario++) {
    const base = 10 ** (-2 + random() * 6);
    const unit = base * (0.001 + random() * 0.005);
    const rows = [];
    for (let i = 0; i < 20; i++) {
      const high = i === 8 ? base + 2 * unit : base + unit;
      rows.push({
        time: i,
        open: base - 0.2 * unit,
        close: base + 0.2 * unit,
        high,
        low: base - unit,
        closeTime: i + 1,
      });
    }
    rows.push({ time: 20, open: base, close: base + 5 * unit, high: base + 5 * unit, low: base - 0.1 * unit, closeTime: 21 });
    rows.push({ time: 21, open: base + 5 * unit, close: base + 5.1 * unit, high: base + 5.2 * unit, low: base + 4.8 * unit, closeTime: 22 });
    const up = findDisplacements(rows);
    assert.equal(up.length, 1);
    assert.equal(up[0].direction, "UP");

    const axis = 4 * base;
    const down = findDisplacements(rows.map((k) => mirrorCandle(k, axis)));
    assert.equal(down.length, 1);
    assert.equal(down[0].direction, "DOWN");
    assert.ok(Math.abs(up[0].body - down[0].body) <= Math.abs(base) * 1e-12);
    assert.ok(Math.abs(up[0].bodyFraction - down[0].bodyFraction) <= 1e-12);

    const wick = rows.map((k) => ({ ...k }));
    wick[20].high = base + 10 * unit;
    wick[20].low = base - 10 * unit;
    assert.equal(findDisplacements(wick).length, 0);
  }
});

