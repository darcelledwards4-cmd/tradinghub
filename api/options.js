// Real-time options chain via Yahoo Finance v10/quoteSummary
// v7/finance/options is IP-blocked on Vercel — v10 uses the same auth pattern as v8 (which works)
// GET /api/options?ticker=NVDA&type=call&expiry=30d
// expiry: '1w' | '30d' | '90d' | '180d' | 'YYYY-MM-DD'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const BASE_HEADERS = {
    'User-Agent': UA,
    'Accept': 'application/json, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://finance.yahoo.com/',
    'Origin': 'https://finance.yahoo.com',
};

// Crumb cache — persists across warm Lambda invocations
const _credCache = { crumb: null, cookie: null, expires: 0 };

async function getYahooCreds() {
    const now = Date.now();
    if (_credCache.crumb && now < _credCache.expires) {
        return { crumb: _credCache.crumb, cookie: _credCache.cookie };
    }
    try {
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
        const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
            headers: { 'User-Agent': UA, 'Cookie': cookieStr, 'Referer': 'https://finance.yahoo.com/', 'Accept': '*/*' },
        });
        if (!r2.ok) return { crumb: null, cookie: cookieStr };
        const crumb = (await r2.text()).trim();
        if (!crumb || crumb.includes('<')) return { crumb: null, cookie: cookieStr };
        _credCache.crumb = crumb;
        _credCache.cookie = cookieStr;
        _credCache.expires = now + 25 * 60 * 1000;
        console.log('[options] crumb ok:', crumb.slice(0, 6) + '…');
        return { crumb, cookie: cookieStr };
    } catch(e) {
        console.error('[options] creds error:', e.message);
        return null;
    }
}

// Fetch expiry dates + current price using v10/quoteSummary
async function fetchExpiryDates(symbol, hdrs, crumbParam) {
    for (const host of ['query2', 'query1']) {
        try {
            // v10/quoteSummary with optionChain module — different endpoint from v7
            const url = `https://${host}.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=optionChain${crumbParam}`;
            const ctrl = new AbortController();
            setTimeout(() => ctrl.abort(), 10000);
            const r = await fetch(url, { headers: hdrs, signal: ctrl.signal });
            if (!r.ok) {
                const body = await r.text().catch(() => '');
                console.error(`[options] ${host} v10 quoteSummary ${r.status}:`, body.slice(0, 200));
                continue;
            }
            const data = await r.json();
            const oc = data?.quoteSummary?.result?.[0]?.optionChain;
            if (!oc) { console.error(`[options] ${host} v10 no optionChain in response`); continue; }
            return {
                currentPrice: oc.quote?.regularMarketPrice || 0,
                expiryDates: oc.expirationDates || [],
                host,
            };
        } catch(e) {
            console.error(`[options] ${host} v10 error:`, e.message);
        }
    }
    return null;
}

// Fetch option contracts for a specific expiry using v10/quoteSummary?date=
async function fetchChain(symbol, targetTs, hdrs, crumbParam, preferredHost) {
    const hosts = preferredHost ? [preferredHost, preferredHost === 'query2' ? 'query1' : 'query2'] : ['query2', 'query1'];
    for (const host of hosts) {
        try {
            const url = `https://${host}.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=optionChain&date=${targetTs}${crumbParam}`;
            const ctrl = new AbortController();
            setTimeout(() => ctrl.abort(), 10000);
            const r = await fetch(url, { headers: hdrs, signal: ctrl.signal });
            if (!r.ok) {
                const body = await r.text().catch(() => '');
                console.error(`[options] ${host} v10 chain ${r.status}:`, body.slice(0, 200));
                continue;
            }
            const data = await r.json();
            const oc = data?.quoteSummary?.result?.[0]?.optionChain;
            if (!oc) { console.error(`[options] ${host} v10 chain: no optionChain`); continue; }
            return oc;
        } catch(e) {
            console.error(`[options] ${host} v10 chain error:`, e.message);
        }
    }
    return null;
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
        // ── 1. Auth ────────────────────────────────────────────────
        const creds = await getYahooCreds();
        const hdrs = {
            ...BASE_HEADERS,
            ...(creds?.cookie ? { 'Cookie': creds.cookie } : {}),
        };
        const crumbParam = creds?.crumb ? `&crumb=${encodeURIComponent(creds.crumb)}` : '';

        // ── 2. Expiry dates via v10/quoteSummary ───────────────────
        const baseInfo = await fetchExpiryDates(symbol, hdrs, crumbParam);
        if (!baseInfo) {
            return res.status(502).json({ error: `Yahoo Finance options unavailable for ${symbol} (v10 blocked)` });
        }

        const { currentPrice, expiryDates, host: preferredHost } = baseInfo;
        if (!expiryDates.length) return res.status(502).json({ error: 'No expiry dates available' });

        // ── 3. Pick target expiry ──────────────────────────────────
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

        // ── 4. Fetch chain for that expiry ─────────────────────────
        const oc = await fetchChain(symbol, targetTs, hdrs, crumbParam, preferredHost);
        if (!oc) return res.status(502).json({ error: `Chain fetch failed for ${symbol} ${expiryDateStr}` });

        const optionsArr = oc.options || [];
        // optionChain.options is an array of {expirationDate, calls, puts}
        // With ?date= it usually returns 1 entry matching the requested date
        const chainEntry = optionsArr.find(o => Math.abs(o.expirationDate - targetTs) < 86400) || optionsArr[0];
        if (!chainEntry) return res.status(502).json({ error: 'No option entry in chain' });

        const contracts = chainEntry[contractType === 'call' ? 'calls' : 'puts'] || [];
        if (!contracts.length) return res.status(502).json({ error: `No ${contractType}s for ${expiryDateStr}` });

        // ── 5. Pick best strike ────────────────────────────────────
        const refStrike = targetStrike || currentPrice;
        const best = contracts.reduce((a, b) =>
            Math.abs(b.strike - refStrike) < Math.abs(a.strike - refStrike) ? b : a
        );

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

        console.log(`[options] ✓ ${symbol} ${contractType} ${expiryDateStr} strike=$${best.strike} bid=$${best.bid} ask=$${best.ask}`);

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
            source:           'yahoo_finance_v10',
        });

    } catch(err) {
        console.error('[options] handler error:', err.message, err.stack?.slice(0, 300));
        return res.status(500).json({ error: err.message });
    }
};
