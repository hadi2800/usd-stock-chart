// سرور: قیمت سهم (تعدیل‌شده) از tse-client + قیمت دلار از نوبیتکس → سری دلاری سهم
const express = require("express");
const path = require("path");
const fs = require("fs");
const tse = require("tse-client");
// پیش‌فرض tse-client این است که فقط اگر ≥۱ روز از آخرین آپدیت گذشته باشد دیتا را به‌روز کند → کش کهنه
tse.UPDATE_INTERVAL = 0;

const PORT = process.env.PORT || 3000;
// واحد قیمت USDTIRT در API نوبیتکس. اگر نمودار دلاری ۱۰ برابر خراب درآمد، این را 'toman' کنید.
// منبع دلار: 'bitycle' (پیش‌فرض، تست‌شده توسط شما) یا 'nobitex'
const USD_SOURCE = process.env.USD_SOURCE || "bitycle";
// bitycle قیمت را به تومان می‌دهد، نوبیتکس به ریال
const USD_UNIT =
  process.env.USD_UNIT || (USD_SOURCE === "bitycle" ? "toman" : "rial");
const USD_SYMBOL = process.env.USD_SYMBOL || "USDTIRT";
const NOBITEX_HOST = process.env.NOBITEX_HOST || "apiv2.nobitex.ir";

const app = express();
// index.html را هم داخل public/ و هم کنار server.js پیدا می‌کند
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, "public", "index.html"))
  ? path.join(__dirname, "public")
  : __dirname;
console.log("Serving static files from:", PUBLIC_DIR);
app.use(express.static(PUBLIC_DIR));
app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

// ---------- کمکی‌ها ----------
const pick = (row, names) => {
  if (Array.isArray(row)) return undefined;
  const keys = Object.keys(row);
  for (const n of names) {
    const k = keys.find((k) => k.toLowerCase() === n.toLowerCase());
    if (k !== undefined) return row[k];
  }
};

// ترتیب پیش‌فرض ستون‌های tse-client اگر ردیف‌ها آرایه باشند:
// Ticker, DTYYYYMMDD, First, High, Low, Close, Value, Vol, OpenInt, Per, Open, Last
function normalizeRow(r) {
  const get = (names, idx) => (Array.isArray(r) ? r[idx] : pick(r, names));
  let d = get(["DTYYYYMMDD"], 1);
  if (d === undefined) d = get(["Date"], 1);
  d = String(d).replace(/\D/g, "");
  if (d.length !== 8) return null;
  const o = +get(["First", "Open"], 2);
  const h = +get(["High"], 3);
  const l = +get(["Low"], 4);
  const c = +get(["Close"], 5);
  const v = +get(["Vol", "Volume"], 7) || 0;
  if (![o, h, l, c].every(Number.isFinite)) return null;
  return { d, o, h, l, c, v };
}

const dateToTs = (d) =>
  Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8));
// ثانیه یونیکس → تاریخ تهران (UTC+3:30) به‌صورت YYYYMMDD
const tsToTehranDate = (sec) => {
  const dt = new Date((sec + 3.5 * 3600) * 1000);
  return dt.toISOString().slice(0, 10).replace(/-/g, "");
};

// ---------- دلار (نوبیتکس UDF) ----------
const usdCache = new Map(); // key: fromSec → {at, map}

// bitycle: هر درخواست حدود ۶۰۰ کندل روزانه تا زمان end برمی‌گرداند؛ برای تاریخچه‌ی بلندتر صفحه‌بندی می‌کنیم
async function fetchUsdBitycle(fromSec) {
  const map = new Map();
  let end = Math.floor(Date.now() / 1000) + 86400;
  let first = true;
  for (let i = 0; i < 12; i++) {
    const url = `https://widget-data.bitycle.com/c1/api/exchange/widget_data?end=${end}&time_frame=1d&is_first=${first}&symbol=${USD_SYMBOL}&source=nobitex_spot`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Bitycle HTTP ${res.status}`);
    const arr = (await res.json()).data || [];
    if (!arr.length) break;
    let minT = Infinity;
    for (const k of arr) {
      map.set(tsToTehranDate(k.t), k.c);
      if (k.t < minT) minT = k.t;
    }
    if (minT <= fromSec || minT >= end) break; // به ابتدای بازه رسیدیم یا پیشرفتی نداریم
    end = minT;
    first = false;
  }
  return map;
}

async function fetchUsd(fromSec) {
  const key = Math.floor(fromSec / 86400);
  const hit = usdCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.map;
  const map =
    USD_SOURCE === "nobitex"
      ? await fetchUsdNobitex(fromSec)
      : await fetchUsdBitycle(fromSec);
  usdCache.set(key, { at: Date.now(), map });
  return map;
}

async function fetchUsdNobitex(fromSec) {
  const key = Math.floor(fromSec / 86400);
  const hit = usdCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.map;

  const map = new Map(); // YYYYMMDD → close (ریال)
  const now = Math.floor(Date.now() / 1000);
  const STEP = 300 * 86400; // پنجره‌های ۳۰۰ روزه برای دور زدن سقف تعداد کندل
  for (let from = fromSec; from < now; from += STEP) {
    const to = Math.min(from + STEP, now);
    const url = `https://${NOBITEX_HOST}/market/udf/history?symbol=${USD_SYMBOL}&resolution=D&from=${from}&to=${to}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Nobitex HTTP ${res.status}`);
    const j = await res.json();
    if (j.s !== "ok" && j.s !== "no_data")
      throw new Error("Nobitex: " + JSON.stringify(j).slice(0, 200));
    (j.t || []).forEach((t, i) => map.set(tsToTehranDate(t), j.c[i]));
  }
  usdCache.set(key, { at: Date.now(), map });
  return map;
}

// خروجی tse-client بسته به نسخه می‌تواند آرایه، آبجکت (ستونی) یا رشته‌ی CSV باشد
function extractRows(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x;
  if (typeof x === "string") {
    const [head, ...lines] = x.trim().split(/\r?\n/);
    const cols = head.split(",").map((s) => s.replace(/"/g, ""));
    return lines.map((ln) => {
      const v = ln.split(",");
      return Object.fromEntries(cols.map((c, i) => [c, v[i]]));
    });
  }
  if (typeof x === "object") {
    // آبجکت ستونی: { date:[...], close:[...] } → آرایه‌ی ردیف‌ها
    const arrKeys = Object.keys(x).filter((k) => Array.isArray(x[k]));
    if (
      arrKeys.length > 3 &&
      arrKeys.every((k) => x[k].length === x[arrKeys[0]].length)
    ) {
      return x[arrKeys[0]].map((_, i) =>
        Object.fromEntries(arrKeys.map((k) => [k, x[k][i]])),
      );
    }
    // آبجکتی که ردیف‌ها داخل یکی از فیلدهایش هستند
    for (const k of Object.keys(x)) {
      const rows = extractRows(x[k]);
      if (rows.length > 1) return rows;
    }
  }
  return [];
}

// ---------- سهام (tse-client) ----------
async function fetchStock(symbol, adjust) {
  const settings = adjust ? { adjustPrices: adjust } : {};
  const res = await tse.getPrices([symbol], settings);
  if (res.error) throw new Error("tse-client: " + JSON.stringify(res.error));
  const rows = extractRows(res.data && res.data[0]);
  const out = rows.map(normalizeRow).filter(Boolean);
  if (!out.length)
    throw new Error(
      "برای این نماد دیتایی پیدا نشد (نماد را دقیق و فارسی وارد کنید).",
    );
  return out.sort((a, b) => (a.d < b.d ? -1 : 1));
}

// ---------- کندل امروز (زنده) از TSETMC ----------
// tse-client فقط تاریخچه‌ی روزهای تمام‌شده را می‌دهد؛ کندل امروز را از این endpoint می‌گیریم.
const TSETMC = "https://cdn.tsetmc.com";
const HDR = { "User-Agent": "Mozilla/5.0", Accept: "application/json" };
const norm = (s) =>
  String(s || "")
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .trim();
let instCache = null;

async function findInsCode(symbol) {
  const sym = norm(symbol);
  try {
    if (!instCache) instCache = await tse.getInstruments();
    const i = instCache.find((x) => norm(x.Symbol) === sym);
    const code = i && (i.InsCode || i.insCode);
    if (code) return String(code);
  } catch (e) {
    /* می‌رویم سراغ جستجوی TSETMC */
  }
  const r = await fetch(
    `${TSETMC}/api/Instrument/GetInstrumentSearch/${encodeURIComponent(sym)}`,
    { headers: HDR },
  );
  const list = (await r.json()).instrumentSearch || [];
  const hit = list.find((x) => norm(x.lVal18AFC) === sym) || list[0];
  return hit && String(hit.insCode);
}

async function fetchToday(symbol) {
  const code = await findInsCode(symbol);
  if (!code) throw new Error("insCode پیدا نشد");
  const r = await fetch(
    `${TSETMC}/api/ClosingPrice/GetClosingPriceInfo/${code}`,
    { headers: HDR },
  );
  if (!r.ok) throw new Error("TSETMC HTTP " + r.status);
  const j = await r.json();
  const i = j.closingPriceInfo || j;
  const c = i.pClosing || i.pDrCotVal;
  if (!i.priceFirst || !c) return null; // امروز معامله‌ای نشده
  return {
    d: String(i.dEven),
    o: i.priceFirst,
    h: i.priceMax,
    l: i.priceMin,
    c,
    v: i.qTotTran5J || 0,
    raw: i,
  };
}

// ---------- API ----------
app.get("/api/series", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "").trim();
    const adjust = [0, 1, 2].includes(+req.query.adjust)
      ? +req.query.adjust
      : 1;
    if (!symbol) return res.status(400).json({ error: "نماد وارد نشده" });

    const stock = await fetchStock(symbol, adjust);
    // اگر تاریخچه هنوز امروز را ندارد، کندل زنده را اضافه کن
    let todayInfo = "disabled";
    if (req.query.live !== "0") {
      try {
        const t = await fetchToday(symbol);
        if (!t) todayInfo = "no-trade-today";
        else if (t.d > stock[stock.length - 1].d) {
          const { raw, ...row } = t;
          stock.push(row);
          todayInfo = "added " + t.d;
        } else todayInfo = "already-in-history";
      } catch (e) {
        todayInfo = "failed: " + e.message;
        console.warn("today candle:", e.message);
      }
    }
    const firstTs = dateToTs(stock[0].d) / 1000;
    const usd = await fetchUsd(firstTs - 5 * 86400);
    const usdDays = [...usd.keys()].sort();
    if (!usdDays.length) throw new Error("دیتای دلار دریافت نشد");

    const div = USD_UNIT === "toman" ? 10 : 1; // تبدیل دلار به ریال
    let pointer = 0;
    let lastUsd = null;
    const irr = [];
    const usdSeries = [];
    for (const r of stock) {
      // آخرین قیمت دلار در همان روز یا نزدیک‌ترین روز قبل
      while (pointer < usdDays.length && usdDays[pointer] <= r.d) {
        lastUsd = usd.get(usdDays[pointer]) * div;
        pointer++;
      }
      const ts = dateToTs(r.d);
      irr.push({
        timestamp: ts,
        open: r.o,
        high: r.h,
        low: r.l,
        close: r.c,
        volume: r.v,
      });
      if (lastUsd) {
        usdSeries.push({
          timestamp: ts,
          open: r.o / lastUsd,
          high: r.h / lastUsd,
          low: r.l / lastUsd,
          close: r.c / lastUsd,
          volume: r.v,
        });
      }
    }
    // آخرین نرخ دلار موجود (ریال) برای حالت «ارزش به نرخ دلار امروز»
    const rate = usd.get(usdDays[usdDays.length - 1]) * div;
    res.json({ symbol, adjust, rate, today: todayInfo, irr, usd: usdSeries });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// برای عیب‌یابی: ساختار خام خروجی‌ها را ببینید
app.get("/api/debug/stock", async (req, res) => {
  try {
    const r = await tse.getPrices([String(req.query.symbol || "خساپا")], {
      adjustPrices: 1,
    });
    const d = r.data && r.data[0];
    const rows = extractRows(d);
    res.json({
      error: r.error,
      topLevelKeys: Object.keys(r),
      dataType: Array.isArray(d) ? "array" : typeof d,
      dataKeys:
        d && typeof d === "object" && !Array.isArray(d)
          ? Object.keys(d)
          : undefined,
      rawPreview: JSON.stringify(d).slice(0, 600),
      rowCount: rows.length,
      lastRows: rows.slice(-2),
      normalized: rows.slice(-2).map(normalizeRow),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
app.get("/api/debug/today", async (req, res) => {
  try {
    res.json(await fetchToday(String(req.query.symbol || "خساپا")));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
app.get("/api/debug/usd", async (req, res) => {
  try {
    const m = await fetchUsd(Math.floor(Date.now() / 1000) - 10 * 86400);
    const e = [...m.entries()].sort();
    res.json({
      source: USD_SOURCE,
      unit: USD_UNIT,
      count: m.size,
      first: e[0],
      last: e.slice(-3),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, () => console.log(`http://localhost:${PORT}`));
