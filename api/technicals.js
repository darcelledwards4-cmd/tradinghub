/**
 * /api/technicals?ticker=NVDA
 *
 * Returns technical indicator data using Tradier for OHLCV and Finnhub for
 * analyst targets, earnings dates, and earnings surprise history.
 *
 * Indicators computed from raw candles:
 *   - RSI(14), 20d/50d/200d MA
 *   - 52-week and 3-month high/low (support & resistance)
 *   - HV30 — 30-day historical volatility (annualized) for IVR context
 *   - Candlestick patterns from the last 10 candles
 *   - Earnings surprise history (last 4 quarters via Finnhub)
 *   - Analyst consensus target + analyst count
 *   - Next earnings date within 90 days
 *
 * Requires: TRADIER_TOKEN, FINNHUB_API_KEY (optional but recommended)
 */

const _techCache = new Map();
const TECH_TTL = 60 * 60 * 1000; // 1-hour cache
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
    if (cached) return res.status(200).json({ ...cached, fromCache: true });

    const tradierToken = process.env.TRADIER_TOKEN;
    const fhKey        = process.env.FINNHUB_API_KEY;
    if (!tradierToken) return res.status(500).json({ error: 'TRADIER_TOKEN not set' });

    const today  = new Date();
    const toDate = fmt(today);
    const fromDate = fmt(new Date(Date.now() - 380 * 86400000)); // 380d → covers MA200 + full 52-wk
    const earn90   = fmt(new Date(Date.now() +  90 * 86400000));

    // ── Parallel fetch ──────────────────────────────────────────────────────
    const [histRes, targetRes, earningsRes, surprisesRes] = await Promise.allSettled([
        fetchTradierHistory(tradierToken, sym, fromDate, toDate),
        fhKey ? fetchJSON(`https://finnhub.io/api/v1/stock/price-target?symbol=${sym}&token=${fhKey}`) : null,
        fhKey ? fetchJSON(`https://finnhub.io/api/v1/calendar/earnings?from=${toDate}&to=${earn90}&symbol=${sym}&token=${fhKey}`) : null,
        fhKey ? fetchJSON(`https://finnhub.io/api/v1/stock/earnings?symbol=${sym}&limit=4&token=${fhKey}`) : null,
    ]);

    // ── OHLCV → indicators ─────────────────────────────────────────────────
    let rsi = null, ma20 = null, ma50 = null, ma200 = null;
    let high52 = null, low52 = null, high90 = null, low90 = null;
    let hv30 = null, currentClose = null, vol10Avg = null;
    let patterns = [];

    const candles = histRes.status === 'fulfilled' ? (histRes.value || []) : [];
    if (candles.length >= 15) {
        const closes  = candles.map(c => c.close);
        const highs   = candles.map(c => c.high);
        const lows    = candles.map(c => c.low);
        const volumes = candles.map(c => c.volume);

        currentClose = closes[closes.length - 1];
        rsi  = calcRSI(closes, 14);
        hv30 = calcHV(closes, 30);   // annualized 30-day historical volatility

        if (closes.length >= 20)  ma20  = avg(closes.slice(-20));
        if (closes.length >= 50)  ma50  = avg(closes.slice(-50));
        if (closes.length >= 200) ma200 = avg(closes.slice(-200));

        // 52-week and 3-month support / resistance
        high52 = Math.max(...highs.slice(-252));
        low52  = Math.min(...lows.slice(-252));
        high90 = Math.max(...highs.slice(-63));
        low90  = Math.min(...lows.slice(-63));

        vol10Avg = avg(volumes.slice(-10));

        // Candlestick patterns from last 10 candles
        patterns = detectPatterns(candles.slice(-10));
    }

    // ── Analyst target (Finnhub) ────────────────────────────────────────────
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

    // ── Earnings surprise history (Finnhub) ─────────────────────────────────
    // Shows whether this company tends to beat or miss analyst estimates
    let earningsSurprises = [];
    const sData = surprisesRes?.status === 'fulfilled' ? surprisesRes.value : null;
    if (Array.isArray(sData) && sData.length) {
        earningsSurprises = sData.map(e => ({
            period:          e.period,
            actual:          e.actual  != null ? round2(e.actual)  : null,
            estimate:        e.estimate != null ? round2(e.estimate) : null,
            surprisePct:     e.surprisePercent != null ? round1(e.surprisePercent) : null,
            beat:            e.actual != null && e.estimate != null ? e.actual > e.estimate : null,
        })).filter(e => e.actual != null);
    }
    // Summary: beats count, avg surprise %
    const beatCount   = earningsSurprises.filter(e => e.beat === true).length;
    const avgSurprise = earningsSurprises.length
        ? round1(earningsSurprises.reduce((s, e) => s + (e.surprisePct || 0), 0) / earningsSurprises.length)
        : null;

    // ── Build AI-prompt summary string ─────────────────────────────────────
    const parts = [];
    if (rsi != null) {
        const lbl = rsi >= 70 ? 'overbought' : rsi <= 30 ? 'oversold' : 'neutral';
        parts.push(`RSI ${rsi.toFixed(1)} (${lbl})`);
    }
    if (currentClose && ma50) {
        const pct = ((currentClose - ma50) / ma50 * 100).toFixed(1);
        parts.push(`${pct >= 0 ? '+' : ''}${pct}% vs 50d MA ($${round2(ma50)})`);
    }
    if (currentClose && ma200) {
        parts.push(`${currentClose > ma200 ? 'above' : 'below'} 200d MA ($${round2(ma200)})`);
    }
    if (hv30 != null) {
        parts.push(`HV30 ${hv30.toFixed(1)}% (annualized historical vol — compare to option IV)`);
    }
    if (high52 && low52) {
        const pctHi = currentClose ? ((high52 - currentClose) / high52 * 100).toFixed(1) : null;
        const pctLo = currentClose ? ((currentClose - low52) / low52 * 100).toFixed(1) : null;
        const pos   = pctHi != null ? ` — ${pctHi}% below 52-wk high, ${pctLo}% above 52-wk low` : '';
        parts.push(`52-week range: $${round2(low52)}–$${round2(high52)}${pos}`);
    }
    if (high90 && low90) {
        parts.push(`3-month range: $${round2(low90)}–$${round2(high90)} (near-term S/R)`);
    }
    if (patterns.length) {
        const bullish = patterns.filter(p => p.signal === 'bullish').map(p => p.name);
        const bearish = patterns.filter(p => p.signal === 'bearish').map(p => p.name);
        const neutral = patterns.filter(p => p.signal === 'neutral').map(p => p.name);
        if (bullish.length) parts.push(`Bullish pattern: ${bullish.join(', ')}`);
        if (bearish.length) parts.push(`Bearish pattern: ${bearish.join(', ')}`);
        if (neutral.length) parts.push(`Neutral pattern: ${neutral.join(', ')}`);
    }
    if (analystTarget) {
        const upside = currentClose ? ((analystTarget - currentClose) / currentClose * 100).toFixed(1) : null;
        parts.push(`analyst target $${analystTarget}${upside != null ? ` (${upside >= 0 ? '+' : ''}${upside}% upside)` : ''}, ${analystCount || '?'} analysts`);
    }
    if (earningsSurprises.length) {
        parts.push(`earnings track record: ${beatCount}/${earningsSurprises.length} beats, avg surprise ${avgSurprise != null ? (avgSurprise >= 0 ? '+' : '') + avgSurprise + '%' : 'n/a'} — use this when sizing near-earnings plays`);
    }
    if (nextEarnings && daysToEarnings != null) {
        parts.push(`next earnings in ${daysToEarnings} days (${nextEarnings})`);
    }

    const summary = parts.length ? parts.join('; ') : 'No technical data available';

    const payload = {
        ticker: sym,
        currentClose: currentClose ? round2(currentClose) : null,
        rsi:    rsi    ? round1(rsi)   : null,
        hv30:   hv30   ? round1(hv30)  : null,
        ma20:   ma20   ? round2(ma20)  : null,
        ma50:   ma50   ? round2(ma50)  : null,
        ma200:  ma200  ? round2(ma200) : null,
        high52: high52 ? round2(high52) : null,
        low52:  low52  ? round2(low52)  : null,
        high90: high90 ? round2(high90) : null,
        low90:  low90  ? round2(low90)  : null,
        vol10Avg:      vol10Avg ? Math.round(vol10Avg) : null,
        patterns,
        earningsSurprises,
        beatCount,
        avgSurprise,
        analystTarget, analystHigh, analystLow, analystCount,
        nextEarnings, daysToEarnings,
        summary,
    };

    _techCacheSet(sym, payload);
    return res.status(200).json(payload);
};

// ── Tradier historical OHLCV ───────────────────────────────────────────────
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

// ── HV(n) — annualized historical volatility from log returns ─────────────
function calcHV(closes, period = 30) {
    if (closes.length < period + 1) return null;
    const slice = closes.slice(-(period + 1));
    const logRet = [];
    for (let i = 1; i < slice.length; i++) {
        if (slice[i - 1] > 0) logRet.push(Math.log(slice[i] / slice[i - 1]));
    }
    if (logRet.length < 2) return null;
    const mean = logRet.reduce((a, b) => a + b, 0) / logRet.length;
    const variance = logRet.reduce((a, b) => a + (b - mean) ** 2, 0) / (logRet.length - 1);
    return Math.sqrt(variance * 252) * 100; // annualized %
}

// ── Candlestick pattern detection (last N candles) ─────────────────────────
function detectPatterns(candles) {
    const results = [];
    const n = candles.length;
    if (n < 2) return results;

    const body       = c => Math.abs(c.close - c.open);
    const range      = c => c.high - c.low;
    const lowerWick  = c => Math.min(c.open, c.close) - c.low;
    const upperWick  = c => c.high - Math.max(c.open, c.close);
    const isGreen    = c => c.close > c.open;
    const isRed      = c => c.close < c.open;

    const c  = candles[n - 1]; // most recent candle
    const p  = candles[n - 2]; // previous candle
    const p2 = n >= 3 ? candles[n - 3] : null;

    // ── Single-candle patterns ──────────────────────────────────────────────
    if (range(c) > 0 && body(c) < 0.1 * range(c)) {
        results.push({ name: 'Doji', signal: 'neutral', desc: 'Indecision — buyers and sellers equal; wait for next candle direction' });
    }

    // Hammer (bullish reversal): small body top, long lower wick ≥ 2× body
    if (body(c) > 0 && lowerWick(c) >= 2 * body(c) && upperWick(c) <= 0.5 * body(c)) {
        results.push({ name: 'Hammer', signal: isGreen(c) ? 'bullish' : 'neutral', desc: 'Buyers rejecting lower prices — potential reversal up' });
    }

    // Shooting Star (bearish reversal): small body bottom, long upper wick ≥ 2× body
    if (body(c) > 0 && upperWick(c) >= 2 * body(c) && lowerWick(c) <= 0.5 * body(c)) {
        results.push({ name: 'Shooting Star', signal: isRed(c) ? 'bearish' : 'neutral', desc: 'Sellers rejecting higher prices — potential reversal down' });
    }

    // ── Two-candle patterns ─────────────────────────────────────────────────
    if (isGreen(c) && isRed(p) && c.open < p.close && c.close > p.open) {
        results.push({ name: 'Bullish Engulfing', signal: 'bullish', desc: 'Strong reversal — green candle fully swallowed the prior red' });
    }

    if (isRed(c) && isGreen(p) && c.open > p.close && c.close < p.open) {
        results.push({ name: 'Bearish Engulfing', signal: 'bearish', desc: 'Strong reversal — red candle fully swallowed the prior green' });
    }

    // Inside Bar: consolidation before a breakout
    if (c.high < p.high && c.low > p.low) {
        results.push({ name: 'Inside Bar', signal: 'neutral', desc: 'Tight consolidation — breakout move likely coming soon' });
    }

    // ── Three-candle patterns ───────────────────────────────────────────────
    if (p2) {
        if (isGreen(c) && isGreen(p) && isGreen(p2) && c.close > p.close && p.close > p2.close) {
            results.push({ name: '3-Day Rally', signal: 'bullish', desc: 'Sustained upward momentum across three sessions' });
        }
        if (isRed(c) && isRed(p) && isRed(p2) && c.close < p.close && p.close < p2.close) {
            results.push({ name: '3-Day Selloff', signal: 'bearish', desc: 'Sustained downward pressure across three sessions' });
        }
        // Morning Star (bullish reversal): big red → small body → big green
        if (isRed(p2) && body(p) < 0.4 * body(p2) && isGreen(c) && c.close > (p2.open + p2.close) / 2) {
            results.push({ name: 'Morning Star', signal: 'bullish', desc: 'Three-candle bullish reversal — strong buy signal' });
        }
        // Evening Star (bearish reversal): big green → small body → big red
        if (isGreen(p2) && body(p) < 0.4 * body(p2) && isRed(c) && c.close < (p2.open + p2.close) / 2) {
            results.push({ name: 'Evening Star', signal: 'bearish', desc: 'Three-candle bearish reversal — strong sell signal' });
        }
    }

    return results;
}

function avg(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function round2(n) { return Math.round(n * 100) / 100; }
function round1(n) { return Math.round(n * 10) / 10; }
function fmt(d)    { return d.toISOString().split('T')[0]; }

async function fetchJSON(url) {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    return r.json();
}
