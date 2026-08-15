import { test } from "node:test";
import assert from "node:assert/strict";
import {
  marketClockState,
  marketNow,
  marketTimeFromLocal,
  resetMarketClockForTest,
  updateMarketClock,
} from "../utils/marketClock.js";

test("市场时钟：按请求往返中点校准 Binance 偏移", () => {
  resetMarketClockForTest();
  const before = 1_000_000;
  const after = 1_000_200;
  const server = 1_000_100 + 55 * 60_000;
  assert.equal(updateMarketClock(server, before, after), true);
  assert.equal(marketClockState().offsetMs, 55 * 60_000);
  assert.equal(marketTimeFromLocal(2_000_000), 2_000_000 + 55 * 60_000);
  assert.ok(marketNow() > Date.now() + 54 * 60_000);
  resetMarketClockForTest();
});
