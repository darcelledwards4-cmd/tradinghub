/**
 * /api/test-polygon?ticker=CPB
 *
 * Raw Polygon diagnostic — shows EXACTLY what your paid plan returns
 * for a single ticker across multiple endpoints, with timestamps so
 * you can see whether the data is live or stale.
 *
 * Visit: https://tradinghub-theta.vercel.app/api/test-polygon?ticker=CPB
 */
module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const ticker  = (req.query.ticker || 'CPB').toUpperCase();
    const apiKey  = process.env.MASSIVE_API_KEY;
    const now     = new Date().toISOString();

    if (!apiKey) {
        return res.status(500).json({ error: 'MASSIVE_API_KEY not set in Vercel env vars' });
    }

    const out = {
        ticker,
        tested_at: now,
        api_key_prefix: apiKey.slice(0, 8) + '...',  // confirm which key is being used
        results: {},
    };

    // ── Test 1: Snapshot (what quotes.js uses) ────────────────────────────────
    try {
        const r = await fetch(
            `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}?apiKey=${apiKey}`,
            { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) }
        );
        const d = await r.json();
        const t = d?.ticker;
        out.results.snapshot = {
            http_status: r.status,
            polygon_status: d?.status,
            error: d?.error || null,
            // The fields we actually use
            'lastTrade.p':      t?.lastTrade?.p    ?? 'MISSING',
            'lastTrade.t':      t?.lastTrade?.t    ? new Date(t.lastTrade.t / 1e6).toISOString() : 'MISSING',
            'day.c':            t?.day?.c          ?? 'MISSING',
            'day.o':            t?.day?.o          ?? 'MISSING',
            'prevDay.c':        t?.prevDay?.c      ?? 'MISSING',
            'min.c':            t?.min?.c          ?? 'MISSING',
            'todaysChangePerc': t?.todaysChangePerc ?? 'MISSING',
            updated:            t?.updated ? new Date(t.updated / 1e6).toISOString() : 'MISSING',
            all_top_keys:       t ? Object.keys(t) : [],
        };
    } catch (e) {
        out.results.snapshot = { error: e.message };
    }

    // ── Test 2: Last trade (most real-time endpoint) ──────────────────────────
    try {
        const r = await fetch(
            `https://api.polygon.io/v2/last/trade/${ticker}?apiKey=${apiKey}`,
            { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6000) }
        );
        const d = await r.json();
        const result = d?.results || d?.last;  // v2 uses results OR last depending on version
        out.results.last_trade = {
            http_status: r.status,
            polygon_status: d?.status,
            price: result?.p ?? result?.price ?? 'MISSING',
            size:  result?.s ?? result?.size  ?? 'MISSING',
            timestamp: result?.t ? new Date(result.t / 1e6).toISOString() : 'MISSING',
            exchange: result?.x ?? 'MISSING',
            raw_keys: result ? Object.keys(result) : [],
        };
    } catch (e) {
        out.results.last_trade = { error: e.message };
    }

    // ── Test 3: Previous close (baseline reference) ───────────────────────────
    try {
        const r = await fetch(
            `https://api.polygon.io/v2/aggs/ticker/${ticker}/prev?adjusted=true&apiKey=${apiKey}`,
            { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6000) }
        );
        const d = await r.json();
        const result = d?.results?.[0];
        out.results.prev_close = {
            http_status: r.status,
            polygon_status: d?.status,
            close: result?.c ?? 'MISSING',
            date:  result?.t ? new Date(result.t).toISOString().split('T')[0] : 'MISSING',
        };
    } catch (e) {
        out.results.prev_close = { error: e.message };
    }

    // ── Test 4: Options snapshot (what the options tab uses) ──────────────────
    try {
        const r = await fetch(
            `https://api.polygon.io/v3/snapshot/options/${ticker}?contract_type=call&limit=3&order=asc&sort=strike_price&apiKey=${apiKey}`,
            { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) }
        );
        const d = await r.json();
        const contracts = (d?.results || []).slice(0, 3);
        out.results.options_snapshot = {
            http_status: r.status,
            polygon_status: d?.status,
            error: d?.error || null,
            count: contracts.length,
            sample_contracts: contracts.map(c => ({
                ticker: c.details?.ticker,
                strike: c.details?.strike_price,
                expiry: c.details?.expiration_date,
                'last_quote.bid': c.last_quote?.bid ?? 'MISSING',
                'last_quote.ask': c.last_quote?.ask ?? 'MISSING',
                'last_quote.timestamp': c.last_quote?.last_updated ? new Date(c.last_quote.last_updated / 1e6).toISOString() : 'MISSING',
                'last_trade.price': c.last_trade?.price ?? 'MISSING',
                'day.close': c.day?.close ?? 'MISSING',
                'implied_volatility': c.implied_volatility ?? 'MISSING',
                has_greeks: !!c.greeks,
                greeks: c.greeks ?? 'MISSING',
            })),
        };
    } catch (e) {
        out.results.options_snapshot = { error: e.message };
    }

    // ── Summary: what would actually be used ─────────────────────────────────
    const snap = out.results.snapshot;
    const usedPrice = snap['lastTrade.p'] !== 'MISSING' ? snap['lastTrade.p']
                    : snap['day.c']       !== 'MISSING' ? snap['day.c']
                    : snap['prevDay.c']   !== 'MISSING' ? snap['prevDay.c']
                    : 'NONE';

    out.summary = {
        would_use_price: usedPrice,
        prev_close: out.results.prev_close?.close,
        is_stale: usedPrice === out.results.prev_close?.close,
        verdict: snap.error ? '❌ Polygon request failed'
                : snap.polygon_status === 'NOT_AUTHORIZED' ? '❌ API key not authorized — check Vercel env vars'
                : usedPrice === 'NONE' ? '❌ No price found in any field'
                : usedPrice === out.results.prev_close?.close ? '⚠️ Price matches prev close — data may be delayed (check your Polygon plan tier)'
                : '✅ Live price returned',
    };

    return res.status(200).json(out);
};
