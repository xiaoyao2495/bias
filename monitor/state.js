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
 * 比较新旧状态，返回变化详情。
 * @param {Object|null} prev 旧状态（无记录 = null）
 * @param {Object} cur 新状态
 * @returns {{ changed: boolean, isNew: boolean, changes: string[] }}
 */
export function compareState(prev, cur) {
  if (!prev) return { changed: true, isNew: true, changes: ["*"] };
  const changes = [];
  for (const key of ["bias", "confidence", "decision"]) {
    if (prev[key] !== cur[key]) changes.push(key);
  }
  return { changed: changes.length > 0, isNew: false, changes };
}
