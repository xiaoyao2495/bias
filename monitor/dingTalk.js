/**
 * dingTalk.js — Monitor Step 3：钉钉机器人推送（自定义关键词模式）
 *
 * Webhook 只从环境变量 DINGTALK_WEBHOOK 读取，不硬编码在代码里。
 * 运行前配置（示例）：
 *   export DINGTALK_WEBHOOK="https://oapi.dingtalk.com/robot/send?access_token=..."
 *   node scripts/runMonitor.js
 *
 * 机器人安全设置：自定义关键词「检测-」——消息文本必须包含该词，
 * 否则钉钉返回 errcode 310000 拒绝发送。sendMarkdown 会自动在文本头部补齐。
 *
 * 国内可直连 oapi.dingtalk.com，不走代理，用原生 fetch。
 */
const KEYWORD = "检测-";
const TIMEOUT_MS = 10_000;

/** 读取 webhook（未配置则抛错，避免静默失败）。
 *  防御：从聊天/文档复制 URL 时容易带上 markdown 反引号（`）或尾部空白，
 *  自动剥离首尾反引号与空白，避免非法 URL 导致推送静默失败。 */
export function getWebhook() {
  let hook = (process.env.DINGTALK_WEBHOOK || "").trim();
  hook = hook.replace(/^`+|`+$/g, "");
  if (!hook) {
    throw new Error('未配置 DINGTALK_WEBHOOK 环境变量。运行前先: export DINGTALK_WEBHOOK="https://oapi.dingtalk.com/robot/send?access_token=..."');
  }
  return hook;
}

/**
 * 发送 markdown 消息（自动确保包含关键词「检测-」）。
 * @param {string} text markdown 文本
 * @param {string} [title] 消息标题
 * @returns {Promise<Object>} 钉钉响应（errcode 0 = 成功）
 */
export async function sendMarkdown(text, title = "4H Bias") {
  const finalText = text.includes(KEYWORD) ? text : `${KEYWORD}${text}`;
  const res = await fetch(getWebhook(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msgtype: "markdown", markdown: { title, text: finalText } }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await res.json();
  if (data.errcode !== 0) throw new Error(`钉钉返回错误 ${data.errcode}: ${data.errmsg}`);
  return data;
}
