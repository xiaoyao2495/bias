// 临时探测：列出 fapi 全部 USDT 永续 symbol，识别股票代币
import { ProxyAgent, request } from "undici";

const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
const agent = PROXY ? new ProxyAgent(PROXY) : null;
const { statusCode, body } = await request("https://fapi.binance.com/fapi/v1/exchangeInfo", { dispatcher: agent });
const info = JSON.parse(await body.text());
const perps = info.symbols.filter((s) => s.contractType === "PERPETUAL" && s.quoteAsset === "USDT" && s.status === "TRADING");
console.log("USDT 永续总数:", perps.length);
console.log(perps.map((s) => s.symbol).join("\n"));
