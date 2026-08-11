/**
 * state.js — Monitor Step 3：状态持久化 + 变化比较
 *
 * state.json 存每个合约上次推送时的 Bias 状态：
 *   { "BTCUSDT": { bias, confidence, decision, scenario, quality, planR } }
 * 运行时文件，已 gitignore，不进版本库。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, "state.json");

/** 读取状态（无文件/损坏 → 空对象） */
export function loadState() {
  try {
    return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
  } catch {
    return {};
  }
}

export function saveState(state) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * 清理状态：只保留仍在监控列表（list）内的合约，剔除跌出 Top20 后的残留。
 * state.json 目前由 runMonitor 全量覆盖写（nextState 只含本轮 list），
 * 残留会被自动清除；此函数显式化该约束并作防御——若未来改为合并写入，
 * 跌出列表的合约状态将不再被覆盖清除，必须经此白名单清理。
 * @param {Object} state 待保存状态
 * @param {string[]} list 本轮监控合约列表（白名单）
 */
export function cleanupState(state, list) {
  const cleaned = {};
  for (const symbol of list) {
    if (state[symbol]) cleaned[symbol] = state[symbol];
  }
  return cleaned;
}

/**
 * 比较新旧状态，返回变化详情。
 * @param {Object|null} prev 旧状态（无记录 = null）
 * @param {Object} cur 新状态
 * @returns {{ changed: boolean, isNew: boolean, changes: string[] }}
 */
export function compareState(prev, cur) {
  if (!prev) return { changed: true, isNew: true, changes: ["*"] };
  const changes = [];
  for (const key of ["bias", "confidence", "decision", "structureAlert", "htfAlert"]) {
    const before = key.endsWith("Alert") ? prev[key] ?? null : prev[key];
    const after = key.endsWith("Alert") ? cur[key] ?? null : cur[key];
    if (before !== after) changes.push(key);
  }
  return { changed: changes.length > 0, isNew: false, changes };
}
