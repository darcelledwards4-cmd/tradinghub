/**
 * /api/technicals?ticker=NVDA
 *
 * Returns real technical indicator data for a ticker:
 *   - RSI(14), 20-day MA, 50-day MA, 200-day MA
 *   - Recent 30-day high / low  (support & resistance levels)
 *   - Analyst consensus price target + analyst count  (Finnhub)
 *   - Next earnings date within 90 days             (Finnhub)
 *   - Trend summary string ready to paste into AI prompts
 *
 * Requires: MASSIVE_API_KEY (Polygon), FINNHUB_API_KEY (optional but recommended)
 */

// ── In-memory cache (1-hour TTL — technicals don't change minute to minute) ──
const _techCache = new Map();
const TECH_TTL = 60 * 60 * 1000; // 1 hour
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

    // Cache hit — return immediately, no API calls needed
    const cached = _techCacheGet(sym);
    if (cached) {
        console.log(`[technicals] cache hit for ${sym}`);
        return res.status(200).json({ ...cached, fromCache: true });
    }

    const polyKey = process.env.MASSIVE_API_KEY;
    const fhKey   = process.env.FINNHUB_API_KEY;

    if (!polyKey) return res.status(500).json({ error: 'MASSIVE_API_KEY not set' });

    // ── Date helpers ────────────────────────────────────────────────────────
    const today = new Date();
    const toDate   = fmt(today);
    const fromDate = fmt(new Date(Date.now() - 220 * 86400000)); // 220 days back → enough for 200MA
    const earn90   = fmt(new Date(Date.now() +  90 * 86400000));

    // ── Parallel fetch: Polygon OHLCV + Finnhub analyst target + Finnhub earnings ──
    const [ohlcvRes, targetRes, earningsRes] = await Promise.allSettled([
        fetchJSON(`https://api.polygon.io/v2/aggs/ticker/${sym}/range/1/day/${fromDate}/${toDate}?adjusted=true&sort=asc&limit=250&apiKey=${polyKey}`),
        fhKey ? fetchJSON(`https://finnhub.io/api/v1/stock/price-target?symbol=${sym}&token=${fhKey}`) : null,
        fhKey ? fetchJSON(`https://finnhub.io/api/v1/calendar/earnings?from=${toDate}&to=${earn90}&symbol=${sym}&token=${fhKey}`) : null,
    ]);

    // ── OHLCV → technicals ──────────────────────────────────────────────────
    let rsi = null, ma20 = null, ma50 = null, ma200 = null;
    let high30 = null, low30 = null, currentClose = null, vol10Avg = null;

    const candles = ohlcvRes.status === 'fulfilled' ? (ohlcvRes.value?.results || []) : [];
    if (candles.length >= 15) {
        const closes  = candles.map(c => c.c);
        const highs   = candles.map(c => c.h);
        const lows    = candles.map(c => c.l);
        const volumes = candles.map(c => c.v);

        currentClose = closes[closes.length - 1];
        rsi   = calcRSI(closes, 14);
        if (closes.length >= 20)  ma20  = avg(closes.slice(-20));
        if (closes.length >= 50)  ma50  = avg(closes.slice(-50));
        if (closes.length >= 200) ma200 = avg(closes.slice(-200));

        // Support & resistance from recent 30-day range
        const recent30H = highs.slice(-30);
        const recent30L = lows.slice(-30);
        high30 = Math.max(...recent30H);
        low30  = Math.min(...recent30L);

        // Average volume last 10 days (context for significance)
        vol10Avg = avg(volumes.slice(-10));
    }

    // ── Analyst price target ────────────────────────────────────────────────
    let analystTarget = null, analystHigh = null, analystLow = null, analystCount = null;
    const tData = targetRes?.status === 'fulfilled' ? targetRes.value : null;
    if (tData?.targetMean) {
        analystTarget = round2(tData.targetMean);
        analystHigh   = tData.targetHigh  ? round2(tData.targetHigh)  : null;
        analystLow    = tData.targetLow   ? round2(tData.targetLow)   : null;
        analystCount  = tData.numberOfAnalysts || null;
    }

    // ── Next earnings date ──────────────────────────────────────────────────
    let nextEarnings = null, daysToEarnings = null;
    const eData = earningsRes?.status === 'fulfilled' ? earningsRes.value : null;
    if (eData?.earningsCalendar?.length) {
        nextEarnings   = eData.earningsCalendar[0].date;
        daysToEarnings = Math.round((new Date(nextEarnings) - today) / 86400000);
    }

    // ── Build a compact summary string for AI prompts ───────────────────────
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
        const above = currentClose > ma200;
        parts.push(`${above ? 'above' : 'below'} 200-day MA ($${round2(ma200)})`);
    }
    if (high30 && low30) {
        parts.push(`30-day range: $${round2(low30)} – $${round2(high30)} (support/resistance)`);
    }
    if (analystTarget) {
        const upside = currentClose ? ((analystTarget - currentClose) / currentClose * 100).toFixed(1) : null;
        const upsideStr = upside != null ? ` (${upside >= 0 ? '+' : ''}${upside}% upside)` : '';
        parts.push(`analyst consensus target $${analystTarget}${upsideStr}, ${analystCount || '?'} analysts`);
    }
    if (nextEarnings && daysToEarnings != null) {
        parts.push(`earnings in ${daysToEarnings} days (${nextEarnings})`);
    }

    const summary = parts.length ? parts.join('; ') : 'No technical data available';

    const payload = {
        ticker: sym,
        currentClose: currentClose ? round2(currentClose) : null,
        rsi:   rsi   ? round1(rsi)   : null,
        ma20:  ma20  ? round2(ma20)  : null,
        ma50:  ma50  ? round2(ma50)  : null,
        ma200: ma200 ? round2(ma200) : null,
        high30: high30 ? round2(high30) : null,
        low30:  low30  ? round2(low30)  : null,
        vol10Avg: vol10Avg ? Math.round(vol10Avg) : null,
        analystTarget, analystHigh, analystLow, analystCount,
        nextEarnings, daysToEarnings,
        summary,
    };

    _techCacheSet(sym, payload);   // cache for 1 hour
    return res.status(200).json(payload);
};

// ── RSI(14) using Wilder's smoothing ───────────────────────────────────────
function calcRSI(closes, period = 14) {
    if (closes.length < period + 1) return null;
    // Seed: simple average for first period
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        const d = closes[i] - closes[i - 1];
        if (d > 0) gains += d; else losses -= d;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    // Wilder smoothing for remaining candles
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
function fmt(d) { return d.toISOString().split('T')[0]; }

async function fetchJSON(url) {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 10000);
    try {
        const r = await fetch(url, { signal: ctrl.signal });
        return await r.json();
    } finally { clearTimeout(tid); }
}
