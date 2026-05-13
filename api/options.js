// Real-time options chain via Yahoo Finance — crumb auth required since 2024
// GET /api/options?ticker=NVDA&type=call&expiry=30d
// expiry: '1w' | '30d' | '90d' | '180d' | 'YYYY-MM-DD'
// Returns best ATM contract with real bid/ask/IV/OI

// Module-level crumb cache — persists across warm Lambda invocations
const _credCache = { crumb: null, cookie: null, expires: 0 };

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function getYahooCreds() {
    const now = Date.now();
    if (_credCache.crumb && now < _credCache.expires) {
        return { crumb: _credCache.crumb, cookie: _credCache.cookie };
    }
    try {
        // Step 1 — visit finance.yahoo.com to collect the B session cookie
        const r1 = await fetch('https://finance.yahoo.com', {
            headers: { 'User-Agent': UA, 'Accept': 'text/html' },
            redirect: 'follow',
        });
        const cookiePairs = [];
        r1.headers.forEach((v, k) => {
            if (k.toLowerCase() === 'set-cookie') {
                const pair = v.split(';')[0];
                if (pair) cookiePairs.push(pair);
            }
        });
        const cookieStr = cookiePairs.join('; ');

        // Step 2 — exchange cookie for crumb
        const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
            headers: {
                'User-Agent': UA,
                'Cookie': cookieStr,
                'Referer': 'https://finance.yahoo.com/',
                'Accept': '*/*',
            },
        });
        if (!r2.ok) { console.error('[options] crumb fetch failed', r2.status); return null; }
        const crumb = (await r2.text()).trim();
        if (!crumb || crumb.includes('<')) { console.error('[options] bad crumb', crumb.slice(0,30)); return null; }

        _credCache.crumb  = crumb;
        _credCache.cookie = cookieStr;
        _credCache.expires = now + 25 * 60 * 1000; // cache 25 min
        console.log('[options] crumb refreshed:', crumb.slice(0, 6) + '…');
        return { crumb, cookie: cookieStr };
    } catch(e) {
        console.error('[options] getYahooCreds error:', e.message);
        return null;
    }
}

function yahooHeaders(creds) {
    return {
        'User-Agent': UA,
        'Accept': 'application/json, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://finance.yahoo.com/',
        'Origin': 'https://finance.yahoo.com',
        ...(creds?.cookie ? { 'Cookie': creds.cookie } : {}),
    };
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    const { ticker, type = 'call', strike, expiry = '30d' } = req.query;
    if (!ticker) return res.status(400).json({ error: 'ticker required' });

    const symbol       = ticker.toUpperCase().trim();
    const contractType = type.toLowerCase() === 'put' ? 'put' : 'call';
    const targetStrike = parseFloat(strike) || null;

    try {
        // ── 1. Get crumb + cookie ──────────────────────────────
        const creds = await getYahooCreds();
        const hdrs  = yahooHeaders(creds);
        const crumbParam = creds?.crumb ? `&crumb=${encodeURIComponent(creds.crumb)}` : '';

        // ── 2. Fetch base options page (expiry dates + quote) ──
        const ctrl1 = new AbortController();
        setTimeout(() => ctrl1.abort(), 10000);

        let baseData = null;
        for (const host of ['query2', 'query1']) {
            const url = `https://${host}.finance.yahoo.com/v7/finance/options/${symbol}${crumbParam ? '?' + crumbParam.slice(1) : ''}`;
            try {
                const r = await fetch(url, { headers: hdrs, signal: ctrl1.signal });
                if (r.ok) { baseData = await r.json(); break; }
                const body = await r.text().catch(() => '');
                console.error(`[options] ${host} base ${r.status}:`, body.slice(0, 150));
            } catch(e) { console.error(`[options] ${host} base error:`, e.message); }
        }

        if (!baseData) return res.status(502).json({ error: `Yahoo Finance options unavailable for ${symbol}` });

        const optResult = baseData?.optionChain?.result?.[0];
        if (!optResult) return res.status(502).json({ error: 'No options result from Yahoo' });

        const currentPrice = optResult.quote?.regularMarketPrice || 0;
        const expiryDates  = optResult.expirationDates || [];
        if (!expiryDates.length) return res.status(502).json({ error: 'No expiry dates available' });

        // ── 3. Pick target expiry timestamp ──────────────────
        const now = Math.floor(Date.now() / 1000);
        let targetTs;

        if (expiry.match(/^\d{4}-\d{2}-\d{2}$/)) {
            const ts = Math.floor(new Date(expiry).getTime() / 1000);
            targetTs = expiryDates.reduce((a, b) => Math.abs(b - ts) < Math.abs(a - ts) ? b : a);
        } else if (expiry === '1w') {
            const cutoff = now + 14 * 86400;
            const weeklies = expiryDates.filter(d => d >= now && d <= cutoff);
            targetTs = weeklies[0] || expiryDates.find(d => d > now) || expiryDates[0];
        } else {
            const days    = parseInt(expiry) || 30;
            const idealTs = now + days * 86400;
            const future  = expiryDates.filter(d => d > now);
            if (!future.length) return res.status(502).json({ error: 'No future expiry dates' });
            targetTs = future.reduce((a, b) => Math.abs(b - idealTs) < Math.abs(a - idealTs) ? b : a);
        }

        const expiryDateStr = new Date(targetTs * 1000).toISOString().split('T')[0];

        // ── 4. Fetch the chain for that specific expiry ───────
        const ctrl2 = new AbortController();
        setTimeout(() => ctrl2.abort(), 10000);

        let chainData = null;
        for (const host of ['query2', 'query1']) {
            const url = `https://${host}.finance.yahoo.com/v7/finance/options/${symbol}?date=${targetTs}${crumbParam}`;
            try {
                const r = await fetch(url, { headers: hdrs, signal: ctrl2.signal });
                if (r.ok) { chainData = await r.json(); break; }
                const body = await r.text().catch(() => '');
                console.error(`[options] ${host} chain ${r.status}:`, body.slice(0, 150));
            } catch(e) { console.error(`[options] ${host} chain error:`, e.message); }
        }

        if (!chainData) return res.status(502).json({ error: 'Chain fetch failed' });

        const chainResult = chainData?.optionChain?.result?.[0];
        if (!chainResult) return res.status(502).json({ error: 'No chain result' });

        const contracts = chainResult.options?.[0]?.[contractType === 'call' ? 'calls' : 'puts'] || [];
        if (!contracts.length) return res.status(502).json({ error: `No ${contractType}s for ${expiryDateStr}` });

        // ── 5. Pick best strike (ATM or closest to requested) ─
        const refStrike = targetStrike || currentPrice;
        const best = contracts.reduce((a, b) =>
            Math.abs(b.strike - refStrike) < Math.abs(a.strike - refStrike) ? b : a
        );

        // Next OTM for comparison
        const otmContracts = contracts.filter(c =>
            contractType === 'call' ? c.strike > best.strike : c.strike < best.strike
        );
        const nextOtm = otmContracts.length
            ? otmContracts.reduce((a, b) => Math.abs(b.strike - best.strike) < Math.abs(a.strike - best.strike) ? b : a)
            : null;

        function fmt(c) {
            if (!c) return null;
            return {
                strike:         c.strike,
                expiry:         expiryDateStr,
                bid:            c.bid            ?? null,
                ask:            c.ask            ?? null,
                last:           c.lastPrice      ?? null,
                mid:            (c.bid != null && c.ask != null) ? parseFloat(((c.bid + c.ask) / 2).toFixed(2)) : null,
                volume:         c.volume         ?? 0,
                openInterest:   c.openInterest   ?? 0,
                iv:             c.impliedVolatility != null ? parseFloat((c.impliedVolatility * 100).toFixed(1)) : null,
                inTheMoney:     c.inTheMoney     ?? false,
                contractSymbol: c.contractSymbol ?? '',
            };
        }

        return res.status(200).json({
            ticker:           symbol,
            contractType,
            currentPrice,
            targetExpiry:     expiryDateStr,
            best:             fmt(best),
            nextOtm:          fmt(nextOtm),
            allStrikes:       contracts.map(c => ({
                strike: c.strike, bid: c.bid ?? null, ask: c.ask ?? null,
                last: c.lastPrice ?? null, volume: c.volume ?? 0, oi: c.openInterest ?? 0, itm: c.inTheMoney ?? false,
            })),
            availableExpiries: expiryDates.map(ts => new Date(ts * 1000).toISOString().split('T')[0]),
            fetchedAt:        new Date().toISOString(),
            source:           'yahoo_finance',
        });

    } catch(err) {
        console.error('[options] handler error:', err.message);
        return res.status(500).json({ error: err.message });
    }
};
