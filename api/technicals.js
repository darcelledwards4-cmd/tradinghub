/**
 * /api/technicals?ticker=NVDA
 *
 * Returns real technical indicator data for a ticker using Tradier for OHLCV
 * and Finnhub for analyst targets and earnings dates.
 *
 * Calculated from raw candles (no Polygon required):
 *   - RSI(14), 20-day MA, 50-day MA, 200-day MA
 *   - 30-day high / low  (support & resistance)
 *   - Analyst consensus price target + analyst count  (Finnhub)
 *   - Next earnings date within 90 days               (Finnhub)
 *   - Trend summary string ready for AI prompt injection
 *
 * Requires: TRADIER_TOKEN, FINNHUB_API_KEY (optional but recommended)
 */

// ── In-memory cache (1-hour TTL) ───────────────────────────────────────────
const _techCache = new Map();
const TECH_TTL = 60 * 60 * 1000;
function _techCacheGet(sym) {
    const e = _techCache.get(sym);
    if (!e) return null;
    if (Date.now() - e.ts > TECH_TTL) { _techCache.delete(sym); return null; }
    return e.data;
}
function _techCacheSet(sym, data) { _techCache.set(sym, { data, ts: Date.now() }); }

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { ticker } = req.query;
    if (!ticker) return res.status(400).json({ error: 'ticker required' });

    const sym = ticker.toUpperCase().trim();

    const cached = _techCacheGet(sym);
    if (cached) {
        console.log(`[technicals] cache hit for ${sym}`);
        return res.status(200).json({ ...cached, fromCache: true });
    }

    const tradierToken = process.env.TRADIER_TOKEN;
    const fhKey        = process.env.FINNHUB_API_KEY;

    if (!tradierToken) return res.status(500).json({ error: 'TRADIER_TOKEN not set' });

    // ── Date helpers ────────────────────────────────────────────────────────
    const today    = new Date();
    const toDate   = fmt(today);
    const fromDate = fmt(new Date(Date.now() - 380 * 86400000)); // 380 days → enough for 200d MA + full 52-wk range
    const earn90   = fmt(new Date(Date.now() +  90 * 86400000));

    // ── Parallel fetch: Tradier history + Finnhub targets + Finnhub earnings ──
    const [histRes, targetRes, earningsRes] = await Promise.allSettled([
        fetchTradierHistory(tradierToken, sym, fromDate, toDate),
        fhKey ? fetchJSON(`https://finnhub.io/api/v1/stock/price-target?symbol=${sym}&token=${fhKey}`) : null,
        fhKey ? fetchJSON(`https://finnhub.io/api/v1/calendar/earnings?from=${toDate}&to=${earn90}&symbol=${sym}&token=${fhKey}`) : null,
    ]);

    // ── OHLCV → compute technicals ─────────────────────────────────────────
    let rsi = null, ma20 = null, ma50 = null, ma200 = null;
    let high52 = null, low52 = null;   // 52-week (≈252 trading days) — major S/R
    let high90 = null, low90 = null;   // 3-month (≈63 trading days)  — near-term S/R
    let currentClose = null, vol10Avg = null;

    const candles = histRes.status === 'fulfilled' ? (histRes.value || []) : [];
    if (candles.length >= 15) {
        const closes  = candles.map(c => c.close);
        const highs   = candles.map(c => c.high);
        const lows    = candles.map(c => c.low);
        const volumes = candles.map(c => c.volume);

        currentClose = closes[closes.length - 1];
        rsi  = calcRSI(closes, 14);
        if (closes.length >= 20)  ma20  = avg(closes.slice(-20));
        if (closes.length >= 50)  ma50  = avg(closes.slice(-50));
        if (closes.length >= 200) ma200 = avg(closes.slice(-200));

        // 52-week high/low — use up to 252 trading-day candles (major support & resistance)
        const w52 = highs.slice(-252);
        const w52L = lows.slice(-252);
        high52 = Math.max(...w52);
        low52  = Math.min(...w52L);

        // 3-month high/low — use up to 63 trading-day candles (near-term S/R)
        const w90 = highs.slice(-63);
        const w90L = lows.slice(-63);
        high90 = Math.max(...w90);
        low90  = Math.min(...w90L);

        vol10Avg = avg(volumes.slice(-10));
    }

    // ── Analyst price target (Finnhub) ──────────────────────────────────────
    let analystTarget = null, analystHigh = null, analystLow = null, analystCount = null;
    const tData = targetRes?.status === 'fulfilled' ? targetRes.value : null;
    if (tData?.targetMean) {
        analystTarget = round2(tData.targetMean);
        analystHigh   = tData.targetHigh  ? round2(tData.targetHigh)  : null;
        analystLow    = tData.targetLow   ? round2(tData.targetLow)   : null;
        analystCount  = tData.numberOfAnalysts || null;
    }

    // ── Next earnings (Finnhub) ─────────────────────────────────────────────
    let nextEarnings = null, daysToEarnings = null;
    const eData = earningsRes?.status === 'fulfilled' ? earningsRes.value : null;
    if (eData?.earningsCalendar?.length) {
        nextEarnings   = eData.earningsCalendar[0].date;
        daysToEarnings = Math.round((new Date(nextEarnings) - today) / 86400000);
    }

    // ── Build compact summary string for AI prompts ─────────────────────────
    const parts = [];
    if (rsi != null) {
        const rsiLabel = rsi >= 70 ? 'overbought' : rsi <= 30 ? 'oversold' : 'neutral';
        parts.push(`RSI ${rsi.toFixed(1)} (${rsiLabel})`);
    }
    if (currentClose && ma50) {
        const pct = ((currentClose - ma50) / ma50 * 100).toFixed(1);
        parts.push(`${pct >= 0 ? '+' : ''}${pct}% vs 50-day MA ($${round2(ma50)})`);
    }
    if (currentClose && ma200) {
        parts.push(`${currentClose > ma200 ? 'above' : 'below'} 200-day MA ($${round2(ma200)})`);
    }
    if (high52 && low52) {
        const pctFromHigh = currentClose ? ((high52 - currentClose) / high52 * 100).toFixed(1) : null;
        const pctFromLow  = currentClose ? ((currentClose - low52)  / low52  * 100).toFixed(1) : null;
        const posStr = pctFromHigh != null && pctFromLow != null
            ? ` — ${pctFromHigh}% below 52-wk high, ${pctFromLow}% above 52-wk low`
            : '';
        parts.push(`52-week range: $${round2(low52)}–$${round2(high52)}${posStr}`);
    }
    if (high90 && low90) {
        parts.push(`3-month range: $${round2(low90)}–$${round2(high90)} (near-term support/resistance)`);
    }
    if (analystTarget) {
        const upside = currentClose ? ((analystTarget - currentClose) / currentClose * 100).toFixed(1) : null;
        const upsideStr = upside != null ? ` (${upside >= 0 ? '+' : ''}${upside}% upside)` : '';
        parts.push(`analyst consensus $${analystTarget}${upsideStr}, ${analystCount || '?'} analysts`);
    }
    if (nextEarnings && daysToEarnings != null) {
        parts.push(`earnings in ${daysToEarnings} days (${nextEarnings})`);
    }

    const summary = parts.length ? parts.join('; ') : 'No technical data available';

    const payload = {
        ticker: sym,
        currentClose: currentClose ? round2(currentClose) : null,
        rsi:    rsi    ? round1(rsi)    : null,
        ma20:   ma20   ? round2(ma20)   : null,
        ma50:   ma50   ? round2(ma50)   : null,
        ma200:  ma200  ? round2(ma200)  : null,
        high30: high30 ? round2(high30) : null,
        low30:  low30  ? round2(low30)  : null,
        vol10Avg: vol10Avg ? Math.round(vol10Avg) : null,
        high52: high52 ? round2(high52) : null,
        low52:  low52  ? round2(low52)  : null,
        high90: high90 ? round2(high90) : null,
        low90:  low90  ? round2(low90)  : null,
        analystTarget, analystHigh, analystLow, analystCount,
        nextEarnings, daysToEarnings,
        summary,
    };

    _techCacheSet(sym, payload);
    return res.status(200).json(payload);
};

// ── Fetch daily history from Tradier ──────────────────────────────────────
async function fetchTradierHistory(token, sym, start, end) {
    const url = `https://api.tradier.com/v1/markets/history?symbol=${encodeURIComponent(sym)}&interval=daily&start=${start}&end=${end}`;
    const r = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`Tradier history ${r.status}`);
    const data = await r.json();
    const days = data?.history?.day;
    if (!days) return [];
    // Always return as array (single day returns an object)
    return Array.isArray(days) ? days : [days];
}

// ── RSI(14) — Wilder's smoothing ──────────────────────────────────────────
function calcRSI(closes, period = 14) {
    if (closes.length < period + 1) return null;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        const d = closes[i] - closes[i - 1];
        if (d > 0) gains += d; else losses -= d;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    for (let i = period + 1; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        avgGain = (avgGain * (period - 1) + Math.max(0, d))  / period;
        avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period;
    }
    if (avgLoss === 0) return 100;
    return 100 - 100 / (1 + avgGain / avgLoss);
}

function avg(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function round2(n) { return Math.round(n * 100) / 100; }
function round1(n) { return Math.round(n * 10)  / 10;  }
function fmt(d)    { return d.toISOString().split('T')[0]; }

async function fetchJSON(url) {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    return r.json();
}
