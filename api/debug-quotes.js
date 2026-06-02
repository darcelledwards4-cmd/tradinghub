/**
 * /api/debug-quotes?symbols=AAPL,NVDA
 *
 * Tests every price source independently and returns raw results so we can
 * see exactly what each API is returning (or failing with).
 */
module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');

    const raw = (req.query.symbols || 'AAPL,NVDA,SPY').toUpperCase();
    const tickers = raw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 5);

    const report = { tickers, sources: {}, timestamp: new Date().toISOString() };

    // ── Source 1: Twelve Data ──────────────────────────────────────────────────
    const tdKey = process.env.TWELVEDATA_API_KEY;
    if (tdKey) {
        try {
            const url = `https://api.twelvedata.com/quote?symbol=${tickers.join(',')}&apikey=${tdKey}`;
            const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
            const status = r.status;
            const body = await r.json();
            // Summarise what each ticker returned
            const tickerSummary = {};
            const entries = tickers.length === 1 ? [[tickers[0], body]] : Object.entries(body);
            for (const [t, q] of entries) {
                if (!q || typeof q !== 'object') { tickerSummary[t] = 'null/invalid'; continue; }
                if (q.code) { tickerSummary[t] = `ERROR code=${q.code} msg=${q.message}`; continue; }
                tickerSummary[t] = `close=${q.close} prev=${q.previous_close} status=${q.status}`;
            }
            report.sources.twelvedata = {
                http_status: status,
                top_level_code: body.code || null,
                top_level_status: body.status || null,
                tickers: tickerSummary,
                raw_keys: Object.keys(body).slice(0, 10),
            };
        } catch (e) {
            report.sources.twelvedata = { error: e.message };
        }
    } else {
        report.sources.twelvedata = { error: 'TWELVEDATA_API_KEY not set' };
    }

    // ── Source 2: Polygon batch snapshot ──────────────────────────────────────
    const polyKey = process.env.MASSIVE_API_KEY;
    if (polyKey) {
        try {
            const url = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${tickers.join(',')}&apiKey=${polyKey}`;
            const r = await fetch(url, {
                headers: { 'Accept': 'application/json' },
                signal: AbortSignal.timeout(8000),
            });
            const status = r.status;
            const body = await r.json();
            const tickerSummary = {};
            for (const t of (body.tickers || [])) {
                const price = t.day?.c;
                const lastTrade = t.lastTrade?.p;
                const prevDay = t.prevDay?.c;
                const min = t.min?.c;
                tickerSummary[t.ticker] = {
                    'day.c': price ?? 'MISSING',
                    'lastTrade.p': lastTrade ?? 'MISSING',
                    'prevDay.c': prevDay ?? 'MISSING',
                    'min.c': min ?? 'MISSING',
                    'todaysChangePerc': t.todaysChangePerc ?? 'MISSING',
                    'day_object': t.day ? 'present' : 'NULL',
                    'all_top_keys': Object.keys(t),
                };
            }
            report.sources.polygon = {
                http_status: status,
                polygon_status: body.status,
                count: body.count ?? (body.tickers || []).length,
                tickers_returned: (body.tickers || []).map(t => t.ticker),
                tickers_requested: tickers,
                ticker_detail: tickerSummary,
                error: body.error || null,
                message: body.message || null,
            };
        } catch (e) {
            report.sources.polygon = { error: e.message };
        }
    } else {
        report.sources.polygon = { error: 'MASSIVE_API_KEY not set' };
    }

    // ── Source 3: Polygon single-ticker quote (alternative endpoint) ──────────
    if (polyKey) {
        try {
            // Test with the first ticker using the v2/last/trade endpoint
            const ticker = tickers[0];
            const url = `https://api.polygon.io/v2/last/trade/${ticker}?apiKey=${polyKey}`;
            const r = await fetch(url, {
                headers: { 'Accept': 'application/json' },
                signal: AbortSignal.timeout(5000),
            });
            const body = await r.json();
            report.sources.polygon_last_trade = {
                http_status: r.status,
                ticker,
                status: body.status,
                price: body.results?.p ?? 'MISSING',
                timestamp: body.results?.t ?? 'MISSING',
            };
        } catch (e) {
            report.sources.polygon_last_trade = { error: e.message };
        }
    }

    // ── Source 4: Polygon prev close (always available) ───────────────────────
    if (polyKey) {
        try {
            const ticker = tickers[0];
            const url = `https://api.polygon.io/v2/aggs/ticker/${ticker}/prev?adjusted=true&apiKey=${polyKey}`;
            const r = await fetch(url, {
                headers: { 'Accept': 'application/json' },
                signal: AbortSignal.timeout(5000),
            });
            const body = await r.json();
            const result = body.results?.[0];
            report.sources.polygon_prev_close = {
                http_status: r.status,
                ticker,
                status: body.status,
                close: result?.c ?? 'MISSING',
                open: result?.o ?? 'MISSING',
                high: result?.h ?? 'MISSING',
                low: result?.l ?? 'MISSING',
                volume: result?.v ?? 'MISSING',
                date: result?.t ? new Date(result.t).toISOString().split('T')[0] : 'MISSING',
            };
        } catch (e) {
            report.sources.polygon_prev_close = { error: e.message };
        }
    }

    // ── Source 5: Yahoo Finance single ticker ─────────────────────────────────
    try {
        const ticker = tickers[0];
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1m&range=1d`;
        const r = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
                'Accept': 'application/json',
            },
            signal: AbortSignal.timeout(7000),
        });
        const body = await r.json();
        const meta = body?.chart?.result?.[0]?.meta;
        report.sources.yahoo = {
            http_status: r.status,
            ticker,
            regularMarketPrice: meta?.regularMarketPrice ?? 'MISSING',
            previousClose: meta?.previousClose ?? 'MISSING',
            marketState: meta?.marketState ?? 'MISSING',
        };
    } catch (e) {
        report.sources.yahoo = { error: e.message };
    }

    return res.status(200).json(report);
};
