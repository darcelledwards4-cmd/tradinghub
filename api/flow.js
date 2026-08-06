/**
 * /api/flow?ticker=TSLA
 *
 * Scans the nearest 1-2 option expirations for unusual activity and fetches
 * ATM implied volatility for IVR approximation (compare to HV30 from /api/technicals).
 *
 * Unusual activity = strikes where volume is large AND volume >> open interest,
 * indicating aggressive NEW positioning (not just hedging existing OI).
 *
 * Returns:
 *   unusual[]     — top flagged strikes (call/put, strike, volume, OI, vol/OI ratio, IV)
 *   atmIV         — implied volatility of the nearest ATM option (for IVR calc)
 *   callFlow      — net call bias score (0-100, 50 = neutral)
 *   putFlow       — net put bias score
 *   flowSummary   — plain-text description for AI prompt injection
 *
 * Requires: TRADIER_TOKEN
 */

const _flowCache = new Map();
const FLOW_TTL = 15 * 60 * 1000; // 15-minute cache (flow data changes faster than technicals)
function _cacheGet(k) {
    const e = _flowCache.get(k);
    if (!e || Date.now() - e.ts > FLOW_TTL) { _flowCache.delete(k); return null; }
    return e.data;
}
function _cacheSet(k, d) { _flowCache.set(k, { data: d, ts: Date.now() }); }

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { ticker } = req.query;
    if (!ticker) return res.status(400).json({ error: 'ticker required' });

    const sym = ticker.toUpperCase().trim();
    const cached = _cacheGet(sym);
    if (cached) return res.status(200).json({ ...cached, fromCache: true });

    const token = process.env.TRADIER_TOKEN;
    if (!token) return res.status(500).json({ error: 'TRADIER_TOKEN not set' });

    try {
        // ── Step 1: Get upcoming expirations ───────────────────────────────
        const expUrl = `https://api.tradier.com/v1/markets/options/expirations?symbol=${encodeURIComponent(sym)}&includeAllRoots=false&strikes=false`;
        const expResp = await fetch(expUrl, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(8000),
        });
        if (!expResp.ok) throw new Error(`Expirations ${expResp.status}`);
        const expData  = await expResp.json();
        let expirations = expData?.expirations?.date || [];
        if (!Array.isArray(expirations)) expirations = expirations ? [expirations] : [];

        // Use nearest 2 expirations (catches both weeklies and next monthly)
        const targetExps = expirations.slice(0, 2);
        if (!targetExps.length) {
            return res.status(200).json({ unusual: [], atmIV: null, callFlow: 50, putFlow: 50, flowSummary: 'No options data available' });
        }

        // ── Step 2: Get the current stock price for ATM strike selection ───
        const quoteResp = await fetch(
            `https://api.tradier.com/v1/markets/quotes?symbols=${sym}&greeks=false`,
            { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(6000) }
        );
        let currentPrice = 0;
        if (quoteResp.ok) {
            const qd = await quoteResp.json();
            let q = qd?.quotes?.quote;
            if (!Array.isArray(q)) q = q ? [q] : [];
            if (q.length) currentPrice = parseFloat(q[0].last || q[0].close || 0);
        }

        // ── Step 3: Fetch chains for target expirations ────────────────────
        const allOptions = [];
        for (const exp of targetExps) {
            try {
                const chainResp = await fetch(
                    `https://api.tradier.com/v1/markets/options/chains?symbol=${encodeURIComponent(sym)}&expiration=${exp}&greeks=true`,
                    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) }
                );
                if (!chainResp.ok) continue;
                const chainData = await chainResp.json();
                let opts = chainData?.options?.option || [];
                if (!Array.isArray(opts)) opts = opts ? [opts] : [];
                opts.forEach(o => allOptions.push({ ...o, _expiry: exp }));
            } catch (e) {
                console.warn(`[flow] chain fetch failed for ${exp}:`, e.message);
            }
        }

        if (!allOptions.length) {
            return res.status(200).json({ unusual: [], atmIV: null, callFlow: 50, putFlow: 50, flowSummary: 'Options chain unavailable' });
        }

        // ── Step 4: Find ATM IV ────────────────────────────────────────────
        // Use the first expiry's chain, closest strike to current price
        const firstExpOpts = allOptions.filter(o => o._expiry === targetExps[0]);
        let atmIV = null;
        if (firstExpOpts.length && currentPrice > 0) {
            const atm = firstExpOpts.reduce((best, o) =>
                Math.abs(o.strike - currentPrice) < Math.abs(best.strike - currentPrice) ? o : best
            );
            const iv = atm?.greeks?.mid_iv ?? atm?.implied_volatility ?? null;
            if (iv != null) atmIV = round1(parseFloat(iv) * 100); // as percentage
        }

        // ── Step 5: Detect unusual activity ───────────────────────────────
        // Criteria: volume > 200 AND (volume/OI > 3 OR OI === 0 with volume > 500)
        const unusual = [];
        let totalCallVol = 0, totalPutVol = 0;

        for (const o of allOptions) {
            const vol = parseInt(o.volume || 0);
            const oi  = parseInt(o.open_interest || 0);
            const type = (o.option_type || '').toLowerCase(); // 'call' or 'put'

            if (type === 'call') totalCallVol += vol;
            if (type === 'put')  totalPutVol  += vol;

            const volOiRatio = oi > 0 ? vol / oi : null;
            const isUnusual  = vol > 200 && (
                (oi > 0  && volOiRatio > 3)   ||  // volume dramatically exceeds existing OI
                (oi === 0 && vol > 500)            // all-new positioning (no prior OI)
            );

            if (isUnusual) {
                const iv = o?.greeks?.mid_iv ?? o?.implied_volatility ?? null;
                unusual.push({
                    type,
                    strike:   o.strike,
                    expiry:   o._expiry,
                    volume:   vol,
                    oi,
                    ratio:    volOiRatio ? round1(volOiRatio) : null,
                    iv:       iv != null ? round1(parseFloat(iv) * 100) : null,
                    bid:      o.bid,
                    ask:      o.ask,
                });
            }
        }

        // Sort by volume descending, keep top 5
        unusual.sort((a, b) => b.volume - a.volume);
        const topUnusual = unusual.slice(0, 5);

        // ── Step 6: Call vs Put flow bias ──────────────────────────────────
        const totalVol = totalCallVol + totalPutVol;
        const callFlow = totalVol > 0 ? Math.round((totalCallVol / totalVol) * 100) : 50;
        const putFlow  = 100 - callFlow;

        // ── Step 7: Plain-text summary for AI prompts ─────────────────────
        const parts = [];
        if (atmIV != null) {
            parts.push(`ATM implied volatility: ${atmIV}% (compare to HV30 to assess if options are cheap or expensive)`);
        }
        if (totalVol > 0) {
            const bias = callFlow > 60 ? 'bullish call-heavy flow' : putFlow > 60 ? 'bearish put-heavy flow' : 'balanced call/put flow';
            parts.push(`Options flow: ${callFlow}% calls / ${putFlow}% puts — ${bias}`);
        }
        if (topUnusual.length) {
            const callUnusual = topUnusual.filter(u => u.type === 'call');
            const putUnusual  = topUnusual.filter(u => u.type === 'put');
            if (callUnusual.length) {
                const top = callUnusual[0];
                parts.push(`Unusual CALL activity: $${top.strike} strike expiring ${top.expiry}, ${top.volume.toLocaleString()} contracts (${top.ratio ? top.ratio + '× OI' : 'new OI'}) — bullish signal`);
            }
            if (putUnusual.length) {
                const top = putUnusual[0];
                parts.push(`Unusual PUT activity: $${top.strike} strike expiring ${top.expiry}, ${top.volume.toLocaleString()} contracts (${top.ratio ? top.ratio + '× OI' : 'new OI'}) — bearish/hedge signal`);
            }
        }
        const flowSummary = parts.length ? parts.join('; ') : 'No unusual options activity detected';

        const payload = { unusual: topUnusual, atmIV, callFlow, putFlow, flowSummary };
        _cacheSet(sym, payload);
        return res.status(200).json(payload);

    } catch (e) {
        console.error('[flow] error:', e.message);
        return res.status(200).json({ unusual: [], atmIV: null, callFlow: 50, putFlow: 50, flowSummary: 'Flow data unavailable', error: e.message });
    }
};

function round1(n) { return Math.round(parseFloat(n) * 10) / 10; }
