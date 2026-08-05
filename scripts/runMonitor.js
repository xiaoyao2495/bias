/**
 * runMonitor.js — Monitor 常驻入口（pm2 保活，进程内自调度）
 *
 * 流程：
 *   getTopVolumeSymbols(15) → analyzeSymbols（串行，防限频）
 *   → compareState → 状态变化则推钉钉 → saveState → 睡到下一个对齐点
 *
 * 调度（北京时间）：
 *   全天每 10 分钟对齐检测一次（pm2 只负责保活，进程内自调度）。
 *
 * 推送策略：
 *   首轮（state.json 无记录）→ 推送一次全览（15 合约当前状态）
 *   后续轮次 → 只推状态变化的合约：
 *     bias 翻转        → ⚠️ {SYMBOL} 4H Bias Changed（含 旧 → 新 对比）
 *     confidence/decision 变化 → ℹ️ {SYMBOL} 4H Bias Updated
 *
 * 用法：
 *   node scripts/runMonitor.js                # 常驻：Top15 全量，自调度
 *   node scripts/runMonitor.js BTCUSDT ETHUSDT  # 常驻：指定合约（测试用）
 *   node scripts/runMonitor.js --once          # 只跑一轮后退出（手动/测试）
 *   node scripts/runMonitor.js --once --dry    # 只计算不推送
 *   DINGTALK_WEBHOOK=xxx node scripts/runMonitor.js  # 配置钉钉 webhook（必须）
 */
import { getTopVolumeSymbols } from "../monitor/topVolume.js";
import { analyzeSymbols } from "../monitor/biasMonitor.js";
import { loadState, saveState, compareState } from "../monitor/state.js";
import { sendMarkdown } from "../monitor/dingTalk.js";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_FILE = join(__dirname, "..", "monitor", "log.txt");

/** 文件日志：Windows 上 pm2 的 out/err 日志空白，写文件便于在服务器上排查 */
function log(...args) {
  const ts = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  const line = `[${ts}] ${args.join(" ")}`;
  try {
    appendFileSync(LOG_FILE, line + "\n");
  } catch {}
  console.error(line);
}

// 模块加载即打点：诊断 pm2 进程是否真正加载/进入了该脚本
log(`[runMonitor] 模块加载（argv1=${process.argv[1] || "(无)"}，pm_exec_path=${process.env.pm_exec_path || "(无)"}，cwd=${process.cwd()}）`);

const TOP_N = 15;
const ICON = { BULLISH: "🟢", BEARISH: "🔴", NEUTRAL: "⚪" };
const BJ_OFFSET_MS = 8 * 3600_000;

/**
 * 执行一轮监控：扫描 → 比较 → 推送变化 → 存状态。
 * @param {Object} [p]
 * @param {string[]} [p.symbols] 指定合约列表（默认 Top15）
 * @param {number} [p.topN=15]
 * @param {boolean} [p.dryRun] 只计算不推送
 */
export async function runMonitor({ symbols, topN = TOP_N, dryRun = false } = {}) {
  const list = symbols && symbols.length ? symbols : (await getTopVolumeSymbols(topN)).map((t) => t.symbol);
  log(`[runMonitor] 开始，合约数=${list.length}: ${list.join(",")}`);
  const results = await analyzeSymbols(list, { onProgress: (n, t) => log(`[runMonitor] 分析进度 ${n}/${t}`) });
  const failed = results.filter((r) => r.error).length;
  log(`[runMonitor] 分析完成：成功 ${results.length - failed} / ${results.length}`);
  const prevState = loadState();
  const isFirstRun = Object.keys(prevState).length === 0;
  const nextState = {};
  const overview = [];
  const changed = [];

  for (const r of results) {
    if (r.error) {
      console.error(`[runMonitor] ${r.symbol} 分析失败: ${r.error}`);
      continue;
    }
    const prev = prevState[r.symbol] || null;
    const cur = {
      bias: r.bias,
      confidence: r.confidence,
      decision: r.decisionLabel,
      scenario: r.scenario,
      quality: r.quality,
      planR: r.planR,
    };
    nextState[r.symbol] = cur;
    const cmp = compareState(prev, cur);
    const item = { symbol: r.symbol, price: r.price, confidenceScore: r.confidenceScore, reason: r.reason, ...cmp, prev, cur };
    overview.push(item);
    if (cmp.changed) changed.push(item);
  }

  if (!dryRun) {
    if (isFirstRun) {
      await sendMarkdown(buildOverview(overview), "4H Bias Monitor");
      log(`[runMonitor] 首轮全览已推送（${overview.length} 合约）`);
    } else {
      for (const item of changed) {
        await sendMarkdown(buildChanged(item), `${item.symbol} Bias`);
        log(`[runMonitor] 已推送 ${item.symbol}（${item.changes.join(",")}）`);
      }
      log(`[runMonitor] 本轮完成: ${changed.length} 变化 / ${overview.length} 合约`);
    }
    saveState(nextState);
    log(`[runMonitor] 状态已保存（${Object.keys(nextState).length} 合约）`);
  }

  return { firstRun: isFirstRun, changed, overview };
}

/**
 * 距下一个对齐点（北京时间）的等待毫秒数。
 * 全天每 10 分钟对齐检测一次。
 * 用 UTC 字段 + 8h 偏移模拟北京时间，与服务器时区无关。
 * @param {Date} [now] 测试可注入
 */
export function nextDelayMs(now = new Date()) {
  const bj = new Date(now.getTime() + BJ_OFFSET_MS);
  const mins = bj.getUTCHours() * 60 + bj.getUTCMinutes() + bj.getUTCSeconds() / 60 + bj.getUTCMilliseconds() / 60000;
  const step = 10; // 全天统一每 10 分钟对齐
  const nextSlot = Math.floor(mins / step) * step + step; // 严格大于当前的对齐点
  return Math.max((nextSlot - mins) * 60_000, 1000); // 至少 1 秒，避免忙循环
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 常驻循环：立即跑一轮，之后按北京时间对齐点定时检测（变化才推送）。
 * @param {Object} [p]
 * @param {string[]} [p.symbols]
 * @param {number} [p.intervalMs] 覆盖调度间隔（测试用）
 */
export async function startMonitorLoop({ symbols, intervalMs } = {}) {
  await runMonitor({ symbols });
  for (;;) {
    const delay = intervalMs ?? nextDelayMs();
    const next = new Date(Date.now() + delay);
    log(`[monitor] 下次检测: ${next.toISOString()}（${Math.round(delay / 60000)} 分钟后）`);
    await sleep(delay);
    try {
      await runMonitor({ symbols });
    } catch (e) {
      log(`[monitor] 本轮失败: ${e.message}，继续下一轮`);
    }
  }
}

/** 首轮全览（紧凑，避免刷屏） */
function buildOverview(list) {
  const lines = [`**4H Bias Monitor**  ${nowHHMM()}`, ""];
  for (const r of list) {
    lines.push(`**${r.symbol}** ${ICON[r.cur.bias] || ""} ${r.cur.bias}`);
    lines.push(`Scenario: ${r.cur.scenario} · 信心度: ${r.cur.confidence}${r.confidenceScore != null ? ` ${r.confidenceScore}` : ""}`);
    lines.push(`机会质量: ${r.cur.quality}${r.cur.planR != null ? ` (${r.cur.planR.toFixed(2)})` : ""} · 操作: ${r.cur.decision}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** 状态变化消息（bias 翻转 → ⚠️，其余 → ℹ️） */
function buildChanged({ symbol, price, reason, changes, prev, cur, confidenceScore }) {
  const biasFlipped = changes.includes("bias");
  const head = biasFlipped ? `**⚠️ ${symbol} 4H Bias 变化**` : `**ℹ️ ${symbol} 4H Bias 更新**`;
  const lines = [head, "", `🕐 ${nowHHMM()}`, ""];

  if (biasFlipped) {
    lines.push(`${ICON[prev.bias] || ""} ${prev.bias} → ${ICON[cur.bias] || ""} ${cur.bias}`, "");
  }
  if (changes.includes("confidence")) {
    lines.push(`信心度: ${prev.confidence} → ${cur.confidence}${confidenceScore != null ? ` ${confidenceScore}` : ""}`);
  }
  if (changes.includes("decision")) {
    lines.push(`操作: ${prev.decision} → ${cur.decision}`);
  }
  if (!biasFlipped && cur.scenario) {
    lines.push(`Scenario: ${cur.scenario}`);
  }
  lines.push(`机会质量: ${cur.quality}${cur.planR != null ? ` (planR ${cur.planR.toFixed(2)})` : ""}`);
  lines.push(`原因: ${reason}`);
  lines.push(`价格: ${price}`);
  return lines.join("\n");
}

/** 北京时间 "2026-08-04 20:00" */
function now() {
  return new Date().toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** 北京时间 hh:mm */
function nowHHMM() {
  return new Date().toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

// CLI 入口：pm2 fork 模式下 argv[1] 是 pm2 容器脚本（ProcessContainerFork.js），
// 真正的入口脚本在 process.env.pm_exec_path；普通命令行运行才用 argv[1]。
const entry = process.env.pm_exec_path || process.argv[1] || "";
if (/runMonitor\.js$/i.test(entry)) {
  log(`[runMonitor] CLI 入口命中（entry=${entry}）`);
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const dryRun = process.argv.includes("--dry");
  const once = process.argv.includes("--once");
  const opts = { symbols: args.length ? args : undefined };
  const task = once ? runMonitor({ ...opts, dryRun }) : startMonitorLoop(opts);
  task
    .then((r) => {
      if (once && dryRun) {
        console.log(`[runMonitor] dry-run: firstRun=${r.firstRun}, changed=${r.changed.length}`);
        for (const c of r.changed) console.log(`  ${c.symbol}: ${c.changes.join(",")}`);
      }
    })
    .catch((e) => {
      log(`[runMonitor] 失败: ${e.message}`);
      console.error(`[runMonitor] 失败: ${e.message}`);
      process.exit(1);
    });
}
