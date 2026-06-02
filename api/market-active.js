// /api/market-active
// Returns today's most active stocks with volume + momentum context
// Uses Polygon gainers/losers/most-active snapshot — cached 30 min
// GET /api/market-active  → { candidates: [{ticker, change_pct, volume, direction, reason}], fetched_at }

let _cache = null;
let _cacheAt = 0;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');

    const polyKey = process.env.MASSIVE_API_KEY;
    if (!polyKey) {
        return res.status(200).json({ candidates: [], fetched_at: new Date().toISOString(), source: 'none', error: 'MASSIVE_API_KEY not set' });
    }

    // Serve from cache if fresh
    if (_cache && (Date.now() - _cacheAt) < CACHE_TTL) {
        return res.status(200).json({ ..._cache, cached: true });
    }

    try {
        // Fetch gainers and losers in parallel — both give us momentum stocks
        const [gainersRes, losersRes] = await Promise.all([
            fetch(`https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/gainers?include_otc=false&apiKey=${polyKey}`, { headers: { Accept: 'application/json' } }),
            fetch(`https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/losers?include_otc=false&apiKey=${polyKey}`, { headers: { Accept: 'application/json' } }),
        ]);

        const [gainersData, losersData] = await Promise.all([
            gainersRes.ok ? gainersRes.json() : { tickers: [] },
            losersRes.ok ? losersRes.json() : { tickers: [] },
        ]);

        const candidates = [];

        const processSnapshot = (tickers, direction) => {
            for (const t of (tickers || []).slice(0, 15)) {
                const ticker = t.ticker;
                if (!ticker || ticker.length > 5) continue; // skip options/weird symbols
                const changePct = t.todaysChangePerc != null ? parseFloat(t.todaysChangePerc.toFixed(2)) : 0;
                const price = t.day?.c || t.lastTrade?.p || t.prevDay?.c || 0;
                const volume = t.day?.v || 0;
                const avgVol = t.prevDay?.v || volume;
                const volMult = avgVol > 0 ? (volume / avgVol).toFixed(1) : null;

                // Skip penny stocks and very high priced stocks for options relevance
                if (price < 5 || price > 800) continue;
                if (volume < 500000) continue; // skip low-liquidity names

                let reason = '';
                if (direction === 'bullish') {
                    reason = `+${changePct}% today`;
                    if (volMult && parseFloat(volMult) > 1.5) reason += `, ${volMult}x avg volume`;
                } else {
                    reason = `${changePct}% today`;
                    if (volMult && parseFloat(volMult) > 1.5) reason += `, ${volMult}x avg volume`;
                }

                candidates.push({ ticker, change_pct: changePct, volume, price, direction, reason });
            }
        };

        processSnapshot(gainersData.tickers, 'bullish');
        processSnapshot(losersData.tickers, 'bearish');

        const result = {
            candidates,
            fetched_at: new Date().toISOString(),
            source: 'polygon',
            count: candidates.length,
        };

        _cache = result;
        _cacheAt = Date.now();

        return res.status(200).json(result);
    } catch (e) {
        return res.status(200).json({ candidates: [], fetched_at: new Date().toISOString(), source: 'error', error: e.message });
    }
};
