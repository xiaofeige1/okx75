/**
 * OKX 永续合约筛选器
 *
 * 条件：
 * 1. 当前K线最高价 > EMA24 && EMA72
 * 2. 当前K线最高价 > 最近完整周末最高价
 *
 * 输出：
 * result.json
 * {
 *   "updateTime": "...",
 *   "symbols": [...]
 * }
 */

import axios from "axios"
import fs from "fs"

// =====================================================
// 参数
// =====================================================

const BAR = "1H"

const EMA_FAST = 24
const EMA_SLOW = 72

const MIN_KLINE = 240

const TOP_N = 50

const MIN_VOL_USDT = 20_000_000

const CONCURRENCY = 1

const FETCH_TIMEOUT = 10000

const MAX_RETRY = 3

// =====================================================
// sleep
// =====================================================

function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

// =====================================================
// axios 请求
// =====================================================

async function fetchJson(url, retry = MAX_RETRY) {

  for (let i = 0; i < retry; i++) {

    try {

      const res = await axios.get(url, {

        timeout: FETCH_TIMEOUT,

        headers: {
          "User-Agent":
            "Mozilla/5.0",
          "Accept": "application/json",
          "Cache-Control": "no-cache"
        }

      })

      return res.data

    } catch (err) {

      const retryable =

        err.code === "ECONNRESET" ||
        err.code === "ETIMEDOUT" ||
        err.code === "ECONNABORTED" ||
        err.code === "EAI_AGAIN" ||

        err.message.includes("429") ||
        err.message.includes("socket hang up") ||
        err.message.includes("TLS") ||
        err.message.includes("fetch failed")

      if (!retryable || i === retry - 1) {
        throw err
      }

      const delay = 1000 * (i + 1)

      console.log(`🔄 retry ${i + 1}`)

      await sleep(delay)
    }
  }
}

// =====================================================
// EMA
// =====================================================

function calcLastEMA(data, period) {

  const k = 2 / (period + 1)

  let ema = data[0]

  for (let i = 1; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k)
  }

  return ema
}

// =====================================================
// 最近完整周末最高价
// =====================================================

function getLastWeekendHighFrom1H(klineData) {

  const weekendMap = new Map()

  for (const d of klineData) {

    const utcTs = +d[0]

    const date = new Date(utcTs)

    const weekday = date.getUTCDay()

    // 只处理周六/周日
    if (weekday !== 6 && weekday !== 0) {
      continue
    }

    const high = +d[2]

    const year = date.getUTCFullYear()

    const start = Date.UTC(year, 0, 1)

    const week = Math.floor(
      (utcTs - start) / (7 * 24 * 3600 * 1000)
    )

    const key = `${year}-${week}`

    if (!weekendMap.has(key)) {

      weekendMap.set(key, {
        saturday: null,
        sunday: null
      })
    }

    const obj = weekendMap.get(key)

    if (weekday === 6) {

      obj.saturday =
        obj.saturday == null
          ? high
          : Math.max(obj.saturday, high)
    }

    if (weekday === 0) {

      obj.sunday =
        obj.sunday == null
          ? high
          : Math.max(obj.sunday, high)
    }
  }

  // 找最近完整周末
  const keys =
    [...weekendMap.keys()]
      .sort()
      .reverse()

  for (const key of keys) {

    const w = weekendMap.get(key)

    if (
      w.saturday != null &&
      w.sunday != null
    ) {
      return Math.max(
        w.saturday,
        w.sunday
      )
    }
  }

  return null
}

// =====================================================
// 单币种处理
// =====================================================

async function processSymbol(t) {

  try {

    const url =
      `https://www.okx.com/api/v5/market/candles?instId=${t.symbol}` +
      `&bar=${BAR}&limit=${MIN_KLINE}`

    const kline = await fetchJson(url)

    if (
      !kline.data ||
      kline.data.length < EMA_SLOW + 5
    ) {
      return null
    }

    const len = kline.data.length

    const closes = new Array(len)
    const highs = new Array(len)

    // OKX 返回最新在前
    // 转换为旧 -> 新

    for (let i = 0; i < len; i++) {

      const d = kline.data[len - 1 - i]

      closes[i] = +d[4]
      highs[i] = +d[2]
    }

    // EMA
    const ema24 =
      calcLastEMA(closes, EMA_FAST)

    const ema72 =
      calcLastEMA(closes, EMA_SLOW)

    // 当前K线最高价
    const currentHigh =
      highs[len - 1]

    // EMA 条件
    if (
      currentHigh <= ema24 ||
      currentHigh <= ema72
    ) {
      return null
    }

    // 最近完整周末最高价
    const weekendHigh =
      getLastWeekendHighFrom1H(kline.data)

    if (weekendHigh == null) {
      return null
    }

    // 当前K线最高价 > 周末最高价
    if (currentHigh <= weekendHigh) {
      return null
    }

    return {

      symbol: t.symbol,

      volUsdt:
        Math.round(t.volUsdt)
    }

  } catch (err) {

    console.log(`❌ ${t.symbol}: ${err.message}`)

    return null
  }
}

// =====================================================
// Promise Pool
// =====================================================

async function runPool(items, worker, concurrency) {

  const results = []

  let index = 0

  async function runner() {

    while (index < items.length) {

      const current = index++

      const result =
        await worker(items[current])

      if (result) {

        results.push(result)

        console.log(`✅ ${result.symbol}`)
      }

      // 防429
      await sleep(500)
    }
  }

  const workers =
    Array(concurrency)
      .fill(0)
      .map(runner)

  await Promise.all(workers)

  return results
}

// =====================================================
// 主逻辑
// =====================================================

async function main() {

  console.log("------------------------------------------------")
  console.log(new Date().toISOString())
  console.log("开始筛选...")
  console.log("------------------------------------------------")

  // 获取成交额排行
  const tickersRes = await fetchJson(
    "https://www.okx.com/api/v5/market/tickers?instType=SWAP"
  )

  if (!tickersRes.data) {
    throw new Error("获取 ticker 失败")
  }

  // 按成交额排序
  const top = tickersRes.data

    .filter(t =>
      t.instId.endsWith("USDT-SWAP")
    )

    .map(t => ({
      symbol: t.instId,
      volUsdt:
        (+t.last) * (+t.vol24h)
    }))

    .filter(t =>
      t.volUsdt > MIN_VOL_USDT
    )

    .sort((a, b) =>
      b.volUsdt - a.volUsdt
    )

    .slice(0, TOP_N)

  console.log(`币种数量: ${top.length}`)

  // 开始筛选
  const results = await runPool(
    top,
    processSymbol,
    CONCURRENCY
  )

  // 按成交额排序
  results.sort((a, b) =>
    b.volUsdt - a.volUsdt
  )

  // 输出 JSON
  const output = {

    updateTime:
      new Date().toISOString(),

    symbols:
      results.map(r => r.symbol)
  }

  // 写入 result.json
  fs.writeFileSync(
    "result.json",
    JSON.stringify(output, null, 2)
  )

  console.log("\n==============================")

  if (results.length === 0) {

    console.log("无符合条件币种")

  } else {

    for (const r of results) {
      console.log(r.symbol)
    }
  }

  console.log("==============================")

  console.log("result.json 已更新")
}

// =====================================================
// 启动
// =====================================================

main().catch(err => {

  console.error("程序异常:", err)

  process.exit(1)
})