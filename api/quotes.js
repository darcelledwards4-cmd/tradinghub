// Real-time batch quotes
// Strategy (in order):
//   1. Tradier                 — live quotes from brokerage account (TRADIER_TOKEN)
//   2. Yahoo Finance v7/quote  — batch, live regularMarketPrice during market hours
//   3. Polygon last-trade      — individual /v2/last/trade per ticker in parallel (real-time tick)
//   4. Polygon snapshot        — batch snapshot, lastTrade.p > day.c > prevDay.c
//   5. Polygon prev-close      — /v2/aggs/ticker/{t}/prev (offline/weekend fallback)
// Returns: { prices: { TICKER: { c, pc, dp, h, l, _isLive } }, source, fetched_at }

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    const raw = (req.query.symbols || '').toUpperCase();
    if (!raw) return res.status(400).json({ error: 'symbols required' });
    const tickers = [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))].slice(0, 100);

    // ── 1. Tradier — live stock quotes (real-time, brokerage account) ─────────
    const tradierToken = process.env.TRADIER_TOKEN;
    if (tradierToken) {
        try {
            const r = await fetch(
                `https://api.tradier.com/v1/markets/quotes?symbols=${tickers.join(',')}&greeks=false`,
                {
                    headers: {
                        'Authorization': `Bearer ${tradierToken}`,
                        'Accept': 'application/json',
                    },
                    signal: AbortSignal.timeout(8000),
                }
            );
            if (r.ok) {
                const data = await r.json();
                let quotes = data?.quotes?.quote ?? [];
                if (!Array.isArray(quotes)) quotes = quotes ? [quotes] : []; // single symbol returns object
                const priceMap = {};
                for (const q of quotes) {
                    if (!q?.symbol || q?.last == null) continue;
                    const price = parseFloat(q.last);
                    const prev  = parseFloat(q.prevclose) || price;
                    if (!price || price <= 0) continue;
                    priceMap[q.symbol.toUpperCase()] = {
                        c:  price,
                        pc: prev,
                        dp: prev ? parseFloat(((price - prev) / prev * 100).toFixed(2)) : 0,
                        h:  parseFloat(q.high)  || price,
                        l:  parseFloat(q.low)   || price,
                        _isLive: true,
                    };
                }
                if (Object.keys(priceMap).length > 0) {
                    console.log(`[quotes] Tradier ✓ ${Object.keys(priceMap).length}/${tickers.length} tickers`);
                    return res.status(200).json({ prices: priceMap, fetched_at: new Date().toISOString(), source: 'tradier', count: Object.keys(priceMap).length });
                }
            } else {
                console.warn(`[quotes] Tradier ${r.status}`);
            }
        } catch (e) { console.warn('[quotes] Tradier error:', e.message); }
    }

    // ── 2. Yahoo Finance v7/quote — batch, live during market hours ───────────
    // This is Yahoo's own real-time quote API — same data their app shows.
    // Less rate-limited than v8/chart, returns regularMarketPrice (true live price).
    try {
        const fields = 'regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketDayHigh,regularMarketDayLow,regularMarketPreviousClose,marketState';
        const hosts  = ['query1', 'query2'];
        let yhData   = null;

        for (const host of hosts) {
            try {
                const url = `https://${host}.finance.yahoo.com/v7/finance/quote?symbols=${tickers.join(',')}&fields=${fields}&formatted=false`;
                const r = await fetch(url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                        'Accept': 'application/json',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Referer': 'https://finance.yahoo.com/',
                        'Origin': 'https://finance.yahoo.com',
                    },
                    signal: AbortSignal.timeout(8000),
                });
                if (r.ok) { yhData = await r.json(); break; }
                if (r.status === 429) { console.warn(`[quotes] Yahoo ${host} 429 — trying next host`); continue; }
            } catch (e) { continue; }
        }

        if (yhData) {
            const results = yhData?.quoteResponse?.result || [];
            const priceMap = {};
            for (const q of results) {
                const price = q.regularMarketPrice;
                const prev  = q.regularMarketPreviousClose || price;
                if (!price || price <= 0) continue;
                priceMap[q.symbol.toUpperCase()] = {
                    c:  price,
                    pc: prev,
                    dp: q.regularMarketChangePercent != null ? parseFloat(q.regularMarketChangePercent.toFixed(2)) : (prev ? parseFloat(((price - prev) / prev * 100).toFixed(2)) : 0),
                    h:  q.regularMarketDayHigh  || price,
                    l:  q.regularMarketDayLow   || price,
                    _isLive: q.marketState === 'REGULAR' || q.marketState === 'PRE' || q.marketState === 'POST',
                };
            }
            if (Object.keys(priceMap).length > 0) {
                const liveCount = Object.values(priceMap).filter(p => p._isLive).length;
                console.log(`[quotes] Yahoo v7/quote ✓ ${Object.keys(priceMap).length}/${tickers.length} tickers, ${liveCount} live`);
                return res.status(200).json({ prices: priceMap, fetched_at: new Date().toISOString(), source: 'yahoo', count: Object.keys(priceMap).length });
            }
        }
    } catch (e) { console.warn('[quotes] Yahoo v7/quote error:', e.message); }

    // ── 2. Polygon last-trade per ticker (parallel) — real-time tick price ────
    // /v2/last/trade returns the most recent SIP tape trade, bypassing snapshot cache.
    const polyKey = process.env.MASSIVE_API_KEY;
    if (polyKey) {
        try {
            const results = await Promise.allSettled(tickers.map(async ticker => {
                // last trade
                const [tradeR, prevR] = await Promise.all([
                    fetch(`https://api.polygon.io/v2/last/trade/${ticker}?apiKey=${polyKey}`, {
                        headers: { 'Accept': 'application/json' },
                        signal: AbortSignal.timeout(6000),
                    }),
                    fetch(`https://api.polygon.io/v2/aggs/ticker/${ticker}/prev?adjusted=true&apiKey=${polyKey}`, {
                        headers: { 'Accept': 'application/json' },
                        signal: AbortSignal.timeout(6000),
                    }),
                ]);
                const tradeData = tradeR.ok ? await tradeR.json() : null;
                const prevData  = prevR.ok  ? await prevR.json()  : null;
                const price = tradeData?.results?.p || tradeData?.last?.price || 0;
                const prev  = prevData?.results?.[0]?.c || 0;
                if (!price || price <= 0) return null;
                const dp = prev > 0 ? parseFloat(((price - prev) / prev * 100).toFixed(2)) : 0;
                return { ticker, c: price, pc: prev || price, dp, h: price, l: price, _isLive: true };
            }));

            const priceMap = {};
            results.forEach(r => {
                if (r.status === 'fulfilled' && r.value) {
                    const { ticker, ...rest } = r.value;
                    priceMap[ticker] = rest;
                }
            });
            if (Object.keys(priceMap).length > 0) {
                console.log(`[quotes] Polygon last-trade ✓ ${Object.keys(priceMap).length}/${tickers.length} tickers`);
                return res.status(200).json({ prices: priceMap, fetched_at: new Date().toISOString(), source: 'polygon', count: Object.keys(priceMap).length });
            }
        } catch (e) { console.warn('[quotes] Polygon last-trade error:', e.message); }
    }

    // ── 3. Polygon batch snapshot ─────────────────────────────────────────────
    if (polyKey) {
        try {
            const r = await fetch(
                `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${tickers.join(',')}&apiKey=${polyKey}`,
                { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(10000) }
            );
            if (r.ok) {
                const data = await r.json();
                if (data.status !== 'NOT_AUTHORIZED' && data.status !== 'ERROR') {
                    const priceMap = {};
                    for (const t of (data.tickers || [])) {
                        const price = t.lastTrade?.p || t.day?.c || t.min?.c || t.prevDay?.c;
                        const prev  = t.prevDay?.c || t.day?.c || price;
                        if (!price || price <= 0) continue;
                        const dpRaw = t.todaysChangePerc != null ? t.todaysChangePerc : (prev ? (price - prev) / prev * 100 : 0);
                        priceMap[t.ticker] = {
                            c: parseFloat(price), pc: parseFloat(prev || price),
                            dp: parseFloat(dpRaw.toFixed(2)),
                            h: parseFloat(t.day?.h || t.prevDay?.h || price),
                            l: parseFloat(t.day?.l || t.prevDay?.l || price),
                            _isLive: !!t.lastTrade?.p,  // only truly live if lastTrade has a price
                        };
                    }
                    if (Object.keys(priceMap).length > 0) {
                        console.log(`[quotes] Polygon snapshot ✓ ${Object.keys(priceMap).length}/${tickers.length} tickers`);
                        return res.status(200).json({ prices: priceMap, fetched_at: new Date().toISOString(), source: 'polygon', count: Object.keys(priceMap).length });
                    }
                } else {
                    console.error('[quotes] Polygon auth error:', data.status, data.message);
                }
            }
        } catch (e) { console.warn('[quotes] Polygon snapshot error:', e.message); }
    }

    // ── 4. Polygon prev-close — always available, never live ─────────────────
    if (polyKey) {
        try {
            const results = await Promise.allSettled(tickers.map(async ticker => {
                const r = await fetch(
                    `https://api.polygon.io/v2/aggs/ticker/${ticker}/prev?adjusted=true&apiKey=${polyKey}`,
                    { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(5000) }
                );
                if (!r.ok) return null;
                const d = await r.json();
                const res = d.results?.[0];
                if (!res?.c) return null;
                return { ticker, c: res.c, pc: res.c, dp: 0, h: res.h || res.c, l: res.l || res.c, _isLive: false };
            }));
            const priceMap = {};
            results.forEach(r => {
                if (r.status === 'fulfilled' && r.value) {
                    const { ticker, ...rest } = r.value;
                    priceMap[ticker] = rest;
                }
            });
            if (Object.keys(priceMap).length > 0) {
                console.log(`[quotes] Polygon prev-close ✓ ${Object.keys(priceMap).length}/${tickers.length} tickers (NOT live)`);
                return res.status(200).json({ prices: priceMap, fetched_at: new Date().toISOString(), source: 'polygon_prev', count: Object.keys(priceMap).length });
            }
        } catch (e) { console.warn('[quotes] Polygon prev-close error:', e.message); }
    }

    // ── 5. Yahoo Finance v8/chart per ticker (last resort) ───────────────────
    const results = await Promise.allSettled(tickers.map(async ticker => {
        try {
            for (const host of ['query2', 'query1']) {
                const r = await fetch(
                    `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=1d`,
                    {
                        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com/' },
                        signal: AbortSignal.timeout(6000),
                    }
                );
                if (!r.ok) continue;
                const data = await r.json();
                const meta = data?.chart?.result?.[0]?.meta;
                if (!meta?.regularMarketPrice) continue;
                const price = meta.regularMarketPrice;
                const prev  = meta.previousClose || meta.chartPreviousClose || price;
                return { ticker, c: price, pc: prev, dp: prev ? parseFloat(((price - prev) / prev * 100).toFixed(2)) : 0, h: meta.regularMarketDayHigh || price, l: meta.regularMarketDayLow || price, _isLive: true };
            }
        } catch (e) {}
        return null;
    }));

    const priceMap = {};
    results.forEach(r => {
        if (r.status === 'fulfilled' && r.value) {
            const { ticker, ...rest } = r.value;
            priceMap[ticker] = rest;
        }
    });
    console.log(`[quotes] Yahoo v8/chart ✓ ${Object.keys(priceMap).length}/${tickers.length} tickers`);
    return res.status(200).json({ prices: priceMap, fetched_at: new Date().toISOString(), source: Object.keys(priceMap).length > 0 ? 'yahoo' : 'none', count: Object.keys(priceMap).length });
};
