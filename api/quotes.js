// Batch real-time quotes — Twelve Data primary, Yahoo Finance fallback
// GET /api/quotes?symbols=NVDA,AAPL,SPY (up to 20 symbols)
// Returns: { prices: { NVDA: { c, pc, dp, h, l }, ... }, fetched_at, source }
module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    const raw = (req.query.symbols || '').toUpperCase();
    if (!raw) return res.status(400).json({ error: 'symbols required' });

    const tickers = [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))].slice(0, 20);

    // ── Try Twelve Data first (TWELVEDATA_API_KEY in Vercel env) ──
    const tdKey = process.env.TWELVEDATA_API_KEY;
    if (tdKey) {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 8000);
            const url = `https://api.twelvedata.com/quote?symbol=${tickers.join(',')}&apikey=${tdKey}`;
            const r = await fetch(url, { signal: controller.signal });
            clearTimeout(timer);

            if (r.ok) {
                const data = await r.json();
                // Top-level error means bad key, rate limit, etc. — fall through
                if (!data.code) {
                    const priceMap = {};
                    // Single ticker returns object directly; multiple returns { TICKER: {...} }
                    const entries = tickers.length === 1
                        ? [[tickers[0], data]]
                        : Object.entries(data);

                    for (const [ticker, q] of entries) {
                        if (!q || q.code || !q.close) continue;
                        const price     = parseFloat(q.close);
                        const prevClose = parseFloat(q.previous_close || q.close);
                        const pct       = prevClose
                            ? parseFloat(((price - prevClose) / prevClose * 100).toFixed(2))
                            : parseFloat(q.percent_change || 0);
                        if (price > 0) {
                            priceMap[ticker.toUpperCase()] = {
                                c: price, pc: prevClose, dp: pct,
                                h: parseFloat(q.high || price),
                                l: parseFloat(q.low  || price),
                            };
                        }
                    }

                    if (Object.keys(priceMap).length > 0) {
                        return res.status(200).json({
                            prices: priceMap,
                            fetched_at: new Date().toISOString(),
                            count: Object.keys(priceMap).length,
                            requested: tickers.length,
                            source: 'twelvedata',
                        });
                    }
                }
            }
        } catch (e) {
            // fall through to Polygon
        }
    }

    // ── Source 2: Polygon batch snapshot (MASSIVE_API_KEY) ────────────────────
    const polyKey = process.env.MASSIVE_API_KEY;
    if (polyKey) {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 8000);
            const url = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${tickers.join(',')}&apiKey=${polyKey}`;
            const r = await fetch(url, {
                headers: { 'Accept': 'application/json' },
                signal: controller.signal,
            });
            clearTimeout(timer);
            if (r.ok) {
                const data = await r.json();
                const priceMap = {};
                for (const t of (data.tickers || [])) {
                    const price = t.day?.c || t.lastTrade?.p || t.prevDay?.c;
                    const prev  = t.prevDay?.c || price;
                    if (price && price > 0) {
                        priceMap[t.ticker] = {
                            c:  parseFloat(price),
                            pc: parseFloat(prev || price),
                            dp: t.todaysChangePerc != null ? parseFloat(t.todaysChangePerc.toFixed(2)) : (prev ? parseFloat(((price - prev) / prev * 100).toFixed(2)) : 0),
                            h:  parseFloat(t.day?.h || price),
                            l:  parseFloat(t.day?.l || price),
                        };
                    }
                }
                if (Object.keys(priceMap).length > 0) {
                    return res.status(200).json({
                        prices: priceMap,
                        fetched_at: new Date().toISOString(),
                        count: Object.keys(priceMap).length,
                        requested: tickers.length,
                        source: 'polygon',
                    });
                }
            }
        } catch (e) {
            // fall through to Yahoo Finance
        }
    }

    // ── Source 3: Yahoo Finance (no key needed) ────────────────
    async function fetchOne(ticker) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 7000);
        try {
            const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=1d&includePrePost=false`;
            const r = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'Accept': 'application/json, text/plain, */*',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Referer': 'https://finance.yahoo.com/',
                    'Origin': 'https://finance.yahoo.com',
                },
                signal: controller.signal
            });
            if (!r.ok) return null;
            const data = await r.json();
            const meta = data?.chart?.result?.[0]?.meta;
            if (!meta || !meta.regularMarketPrice) return null;
            const price     = meta.regularMarketPrice;
            const prevClose = meta.previousClose || meta.chartPreviousClose || price;
            const pct       = prevClose ? parseFloat(((price - prevClose) / prevClose * 100).toFixed(2)) : 0;
            return { c: price, pc: prevClose, dp: pct, h: meta.regularMarketDayHigh || price, l: meta.regularMarketDayLow || price };
        } catch (e) {
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    const results = await Promise.allSettled(tickers.map(fetchOne));
    const priceMap = {};
    tickers.forEach((ticker, i) => {
        const r = results[i];
        if (r.status === 'fulfilled' && r.value) priceMap[ticker] = r.value;
    });

    return res.status(200).json({
        prices: priceMap,
        fetched_at: new Date().toISOString(),
        count: Object.keys(priceMap).length,
        requested: tickers.length,
        source: 'yahoo',
    });
};
