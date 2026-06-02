// Batch real-time quotes — Polygon primary (paid), Twelve Data secondary, Yahoo Finance fallback
// GET /api/quotes?symbols=NVDA,AAPL,SPY (up to 20 symbols)
// Returns: { prices: { NVDA: { c, pc, dp, h, l }, ... }, fetched_at, source }
module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    const raw = (req.query.symbols || '').toUpperCase();
    if (!raw) return res.status(400).json({ error: 'symbols required' });

    const tickers = [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))].slice(0, 20);

    // ── Source 1: Polygon batch snapshot (MASSIVE_API_KEY) — paid plan, most reliable ──
    const polyKey = process.env.MASSIVE_API_KEY;
    if (polyKey) {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 10000);
            const url = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${tickers.join(',')}&apiKey=${polyKey}`;
            const r = await fetch(url, {
                headers: { 'Accept': 'application/json' },
                signal: controller.signal,
            });
            clearTimeout(timer);

            if (r.ok) {
                const data = await r.json();

                // Check for Polygon auth/error responses (200 but error body)
                if (data.status === 'NOT_AUTHORIZED' || data.status === 'ERROR') {
                    console.error('[quotes] Polygon error status:', data.status, data.error || data.message || '');
                    // fall through to next source
                } else {
                    const priceMap = {};
                    for (const t of (data.tickers || [])) {
                        // Price priority:
                        //   1. lastTrade.p — most recent actual trade (best during market hours)
                        //   2. day.c — current session close/last (updates intraday)
                        //   3. min.c — last minute bar close
                        //   4. prevDay.c — previous session close (always available)
                        const price = t.lastTrade?.p || t.day?.c || t.min?.c || t.prevDay?.c;
                        const prev  = t.prevDay?.c || t.day?.c || price;
                        if (price && price > 0) {
                            // todaysChangePerc is computed against prevDay, which is what we want
                            const dpRaw = t.todaysChangePerc != null
                                ? t.todaysChangePerc
                                : (prev && prev > 0 ? ((price - prev) / prev * 100) : 0);
                            priceMap[t.ticker] = {
                                c:  parseFloat(price),
                                pc: parseFloat(prev || price),
                                dp: parseFloat(dpRaw.toFixed(2)),
                                h:  parseFloat(t.day?.h || t.prevDay?.h || price),
                                l:  parseFloat(t.day?.l || t.prevDay?.l || price),
                            };
                        }
                    }

                    if (Object.keys(priceMap).length > 0) {
                        console.log('[quotes] Polygon ✓', Object.keys(priceMap).length, '/', tickers.length, 'tickers');
                        return res.status(200).json({
                            prices: priceMap,
                            fetched_at: new Date().toISOString(),
                            count: Object.keys(priceMap).length,
                            requested: tickers.length,
                            source: 'polygon',
                        });
                    } else {
                        console.warn('[quotes] Polygon returned 0 tickers from snapshot. status=', data.status, 'count=', data.count);
                    }
                }
            } else {
                console.warn('[quotes] Polygon HTTP', r.status);
            }
        } catch (e) {
            console.error('[quotes] Polygon error:', e.message);
        }
    }

    // ── Source 2: Polygon prev-close batch (fallback — always has data, even on weekends) ──
    // Uses the /v2/aggs/grouped/locale/us/market/stocks/{date} endpoint
    if (polyKey) {
        try {
            // Get last 2 trading day dates to find the most recent available
            const today = new Date();
            const dates = [];
            for (let i = 0; i < 5; i++) {
                const d = new Date(today);
                d.setDate(d.getDate() - i);
                const day = d.getDay();
                if (day !== 0 && day !== 6) { // skip weekends
                    dates.push(d.toISOString().split('T')[0]);
                    if (dates.length >= 2) break;
                }
            }

            // Try prev-close for each ticker via /v2/aggs/ticker/{t}/prev
            const results = await Promise.allSettled(
                tickers.map(async ticker => {
                    const url = `https://api.polygon.io/v2/aggs/ticker/${ticker}/prev?adjusted=true&apiKey=${polyKey}`;
                    const r = await fetch(url, {
                        headers: { 'Accept': 'application/json' },
                        signal: AbortSignal.timeout(6000),
                    });
                    if (!r.ok) return null;
                    const d = await r.json();
                    const result = d.results?.[0];
                    if (!result || !result.c) return null;
                    return { ticker, c: result.c, o: result.o, h: result.h, l: result.l };
                })
            );

            const priceMap = {};
            results.forEach((r, i) => {
                if (r.status === 'fulfilled' && r.value) {
                    const { ticker, c, h, l } = r.value;
                    priceMap[ticker] = { c, pc: c, dp: 0, h: h || c, l: l || c };
                }
            });

            if (Object.keys(priceMap).length > 0) {
                console.log('[quotes] Polygon prev-close ✓', Object.keys(priceMap).length, '/', tickers.length, 'tickers');
                return res.status(200).json({
                    prices: priceMap,
                    fetched_at: new Date().toISOString(),
                    count: Object.keys(priceMap).length,
                    requested: tickers.length,
                    source: 'polygon_prev',
                });
            }
        } catch (e) {
            console.error('[quotes] Polygon prev-close error:', e.message);
        }
    }

    // ── Source 3: Twelve Data (TWELVEDATA_API_KEY in Vercel env) ──────────────
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
                        console.log('[quotes] Twelve Data ✓', Object.keys(priceMap).length, '/', tickers.length);
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
            console.error('[quotes] Twelve Data error:', e.message);
        }
    }

    // ── Source 4: Yahoo Finance (no key needed) ────────────────────────────────
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

    console.log('[quotes] Yahoo ✓', Object.keys(priceMap).length, '/', tickers.length);
    return res.status(200).json({
        prices: priceMap,
        fetched_at: new Date().toISOString(),
        count: Object.keys(priceMap).length,
        requested: tickers.length,
        source: 'yahoo',
    });
};
