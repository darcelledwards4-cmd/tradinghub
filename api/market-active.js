// /api/market-active
// Returns today's real movers using Tradier live quotes + Finnhub news headlines
// Claude uses this data to make educated picks instead of defaulting to AAPL/MSFT/GOOG
// GET /api/market-active → { candidates: [{ticker, price, change_pct, direction, reason, news}] }

let _cache = null;
let _cacheAt = 0;
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

// Curated basket of liquid, option-friendly stocks across sectors
// Broad enough to surface real movers without being too narrow
const BASKET = [
    // Mega-cap tech
    'AAPL','MSFT','NVDA','META','GOOGL','AMZN','AMD','INTC','CRM','ORCL','TSLA','NFLX',
    // Finance
    'JPM','BAC','GS','MS','V','MA','AXP','C','WFC',
    // Healthcare
    'UNH','JNJ','PFE','MRNA','ABBV','LLY','AMGN','GILD',
    // Energy
    'XOM','CVX','OXY','SLB','BP',
    // Consumer / Retail
    'HD','NKE','MCD','SBUX','WMT','TGT','COST','LULU',
    // Industrials / Defense
    'BA','CAT','GE','RTX','LMT',
    // High-momentum / growth
    'COIN','PLTR','SOFI','HOOD','RBLX','UBER','LYFT','SNAP','SPOT',
    // Small/mid movers often in play
    'RIVN','GME','AMC','MARA','RIOT',
];

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');

    // Serve from cache if fresh
    if (_cache && (Date.now() - _cacheAt) < CACHE_TTL) {
        return res.status(200).json({ ..._cache, cached: true });
    }

    const tradierToken = process.env.TRADIER_TOKEN;
    const finnhubKey   = process.env.FINNHUB_API_KEY;

    if (!tradierToken) {
        return res.status(200).json({ candidates: [], fetched_at: new Date().toISOString(), source: 'none', error: 'TRADIER_TOKEN not set' });
    }

    try {
        // ── Step 1: Get live quotes for the full basket from Tradier ──────────
        const quotesRes = await fetch(
            `https://api.tradier.com/v1/markets/quotes?symbols=${BASKET.join(',')}&greeks=false`,
            {
                headers: { 'Authorization': `Bearer ${tradierToken}`, 'Accept': 'application/json' },
                signal: AbortSignal.timeout(10000),
            }
        );

        if (!quotesRes.ok) {
            throw new Error(`Tradier quotes ${quotesRes.status}`);
        }

        const quotesData = await quotesRes.json();
        let quotes = quotesData?.quotes?.quote ?? [];
        if (!Array.isArray(quotes)) quotes = quotes ? [quotes] : [];

        // ── Step 2: Filter and rank by % change ───────────────────────────────
        const ranked = quotes
            .filter(q => q?.last && q?.change_percentage != null && q.last >= 5 && q.last <= 800)
            .filter(q => (q.volume || 0) >= 500000) // skip illiquid names
            .map(q => ({
                ticker:     q.symbol,
                price:      parseFloat(q.last),
                change_pct: parseFloat(parseFloat(q.change_percentage).toFixed(2)),
                volume:     parseInt(q.volume) || 0,
                avg_volume: parseInt(q.average_volume) || parseInt(q.volume) || 1,
            }))
            .filter(q => Math.abs(q.change_pct) >= 0.5); // skip flat stocks

        // Sort: biggest movers first
        ranked.sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct));

        // Take top 12 gainers + top 12 losers
        const gainers = ranked.filter(q => q.change_pct > 0).slice(0, 12);
        const losers  = ranked.filter(q => q.change_pct < 0).slice(0, 12);
        const topMovers = [...gainers, ...losers];

        if (!topMovers.length) {
            return res.status(200).json({ candidates: [], fetched_at: new Date().toISOString(), source: 'tradier', note: 'No significant movers found' });
        }

        // ── Step 3: Fetch Finnhub news for top movers (enrich context) ────────
        const today = new Date();
        const fromDate = new Date(today - 7 * 86400 * 1000).toISOString().split('T')[0];
        const toDate   = today.toISOString().split('T')[0];

        const newsMap = {};
        if (finnhubKey && topMovers.length) {
            // Fetch news for top 10 movers in parallel (avoid rate limits)
            const newsTargets = topMovers.slice(0, 10);
            const newsResults = await Promise.allSettled(
                newsTargets.map(async m => {
                    try {
                        const r = await fetch(
                            `https://finnhub.io/api/v1/company-news?symbol=${m.ticker}&from=${fromDate}&to=${toDate}&token=${finnhubKey}`,
                            { signal: AbortSignal.timeout(4000) }
                        );
                        if (!r.ok) return { ticker: m.ticker, headline: null };
                        const articles = await r.json();
                        const top = Array.isArray(articles) ? articles[0] : null;
                        return { ticker: m.ticker, headline: top?.headline || null };
                    } catch { return { ticker: m.ticker, headline: null }; }
                })
            );
            newsResults.forEach(r => {
                if (r.status === 'fulfilled' && r.value?.ticker) {
                    newsMap[r.value.ticker] = r.value.headline;
                }
            });
        }

        // ── Step 4: Build enriched candidates for Claude ──────────────────────
        const candidates = topMovers.map(m => {
            const direction = m.change_pct > 0 ? 'bullish' : 'bearish';
            const volMult = m.avg_volume > 0 ? (m.volume / m.avg_volume).toFixed(1) : null;
            const headline = newsMap[m.ticker];

            let reason = `${m.change_pct > 0 ? '+' : ''}${m.change_pct}% today`;
            if (volMult && parseFloat(volMult) > 1.3) reason += `, ${volMult}x avg volume`;
            if (headline) reason += ` — "${headline}"`;

            return { ticker: m.ticker, price: m.price, change_pct: m.change_pct, volume: m.volume, direction, reason };
        });

        const result = {
            candidates,
            fetched_at: new Date().toISOString(),
            source: 'tradier+finnhub',
            count: candidates.length,
        };

        _cache = result;
        _cacheAt = Date.now();

        return res.status(200).json(result);

    } catch (e) {
        console.error('[market-active] error:', e.message);
        return res.status(200).json({ candidates: [], fetched_at: new Date().toISOString(), source: 'error', error: e.message });
    }
};
