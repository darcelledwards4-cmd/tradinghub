// Real-time options chain — Massive primary (MASSIVE_API_KEY required), Yahoo v10 fallback
// GET /api/options?ticker=NVDA&type=call&expiry=30d
// expiry: '1w' | '30d' | '90d' | '180d' | 'YYYY-MM-DD'
//
// Setup: add MASSIVE_API_KEY to Vercel environment variables
//   https://app.vercel.com → project → Settings → Environment Variables

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── In-memory cache (survives warm Vercel instances, 8-min TTL) ──────────────
const _optCache = new Map();
const OPT_TTL = 8 * 60 * 1000; // 8 minutes
function _cacheKey(symbol, contractType, targetDateStr) {
    return `${symbol}|${contractType}|${targetDateStr}`;
}
function _cacheGet(key) {
    const entry = _optCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > OPT_TTL) { _optCache.delete(key); return null; }
    return entry.data;
}
function _cacheSet(key, data) { _optCache.set(key, { data, ts: Date.now() }); }

// ── Massive options fetch ────────────────────────────────────────────────────
async function fetchMassiveOptions(symbol, contractType, targetDate, currentPrice, apiKey) {
    const targetMs = new Date(targetDate).getTime();
    const fromDate = new Date(targetMs - 14 * 86400 * 1000).toISOString().split('T')[0];
    const toDate   = new Date(targetMs + 14 * 86400 * 1000).toISOString().split('T')[0];

    // Add strike range filter: ±30% of current price keeps ATM in results even for
    // high-priced stocks (NVDA $450+, META $700+) where near-term options have many
    // strikes and the limit=250 sorted from lowest would miss the ATM strike.
    const strikeMin = currentPrice > 0 ? `&strike_price.gte=${(currentPrice * 0.70).toFixed(2)}` : '';
    const strikeMax = currentPrice > 0 ? `&strike_price.lte=${(currentPrice * 1.35).toFixed(2)}` : '';

    const url = [
        `https://api.polygon.io/v3/snapshot/options/${symbol}`,
        `?contract_type=${contractType}`,
        `&expiration_date.gte=${fromDate}`,
        `&expiration_date.lte=${toDate}`,
        strikeMin,
        strikeMax,
        `&limit=250`,
        `&order=asc`,
        `&sort=strike_price`,
        `&apiKey=${apiKey}`,
    ].join('');

    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 15000); // increased from 12s — near-term options can be slower

    const r = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        signal: ctrl.signal,
    });

    if (!r.ok) {
        const body = await r.text().catch(() => '');
        console.error(`[options] Massive ${r.status}:`, body.slice(0, 200));
        return null;
    }

    const data = await r.json();
    if (!data.results || !data.results.length) {
        // Free Polygon tier returns 200 + empty array for options — paid plan required
        console.error('[options] Massive: empty results for', symbol, contractType, fromDate, '–', toDate, '| status:', data.status, '| count:', data.results?.length ?? 'undefined');
        return null;
    }

    // Group by expiration date, pick closest to target
    const byExpiry = {};
    for (const opt of data.results) {
        const exp = opt.details?.expiration_date;
        if (exp) { if (!byExpiry[exp]) byExpiry[exp] = []; byExpiry[exp].push(opt); }
    }
    const expiries = Object.keys(byExpiry).sort();
    if (!expiries.length) return null;

    const bestExpiry = expiries.reduce((a, b) => {
        const da = Math.abs(new Date(a).getTime() - targetMs);
        const db = Math.abs(new Date(b).getTime() - targetMs);
        return db < da ? b : a;
    });

    const contracts = byExpiry[bestExpiry];
    const ref = currentPrice || 0;
    const best = contracts.reduce((a, b) => {
        const sa = Math.abs((a.details?.strike_price || 0) - ref);
        const sb = Math.abs((b.details?.strike_price || 0) - ref);
        return sb < sa ? b : a;
    });

    const q          = best.last_quote;
    const bid        = q?.bid         ?? null;
    const ask        = q?.ask         ?? null;
    const mid        = q?.midpoint    ?? (bid != null && ask != null ? (bid + ask) / 2 : null);
    const iv         = best.implied_volatility != null ? parseFloat((best.implied_volatility * 100).toFixed(1)) : null;
    const oi         = best.open_interest ?? 0;
    const last       = best.last_trade?.price  ?? null;
    const dayClose   = best.day?.close         ?? null;  // prev session close — always populated
    const dayOpen    = best.day?.open          ?? null;
    const dayVwap    = best.day?.vwap          ?? null;

    // Accept any available price — bid/ask live during hours, day.close always available
    if (bid == null && ask == null && last == null && dayClose == null) {
        console.error('[options] Massive: all price fields null for', best.details?.ticker, '— raw day:', JSON.stringify(best.day));
        return null;
    }

    // Determine price type for display
    const priceType = (bid != null || ask != null) ? 'live'
                    : last != null ? 'last_trade'
                    : 'prev_close';

    // Extract Greeks if available (Polygon paid plan)
    const greeks     = best.greeks ?? null;
    const delta      = greeks?.delta  != null ? parseFloat(greeks.delta.toFixed(3))  : null;
    const gamma      = greeks?.gamma  != null ? parseFloat(greeks.gamma.toFixed(4))  : null;
    const theta      = greeks?.theta  != null ? parseFloat(greeks.theta.toFixed(4))  : null;
    const vega       = greeks?.vega   != null ? parseFloat(greeks.vega.toFixed(4))   : null;

    console.log(`[options] ✓ Massive ${symbol} ${contractType} ${bestExpiry} strike=$${best.details?.strike_price} bid=$${bid} ask=$${ask} last=$${last} close=$${dayClose} type=${priceType} delta=${delta}`);

    return {
        strike:         best.details?.strike_price ?? null,
        expiry:         bestExpiry,
        bid, ask,
        mid:            mid != null ? parseFloat(mid.toFixed(2)) : null,
        last:           last ?? dayClose,   // fall back to prev session close
        volume:         best.day?.volume ?? 0,
        openInterest:   oi, iv,
        inTheMoney:     (contractType === 'call' ? ref > (best.details?.strike_price || 0) : ref < (best.details?.strike_price || 0)),
        contractSymbol: best.details?.ticker ?? '',
        priceType,      // 'live' | 'last_trade' | 'prev_close'
        source:         'massive',
        delta, gamma, theta, vega,  // Greeks (null if not on paid Polygon plan)
    };
}

// ── Tradier options chain ────────────────────────────────────────────────────
// Free developer sandbox: real bid/ask, 15-min delayed. Sign up at tradier.com/create/developer
// Sandbox base: https://sandbox.tradier.com/v1/ (use api.tradier.com for live brokerage account)
async function fetchTradierOptions(symbol, contractType, targetDateStr, currentPrice, apiKey) {
    const base = 'https://sandbox.tradier.com/v1';
    const hdrs = { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json', 'User-Agent': UA };

    // Step 1: Get available expiration dates
    const ctrl1 = new AbortController();
    setTimeout(() => ctrl1.abort(), 10000);
    let expirations = [];
    try {
        const r1 = await fetch(`${base}/markets/options/expirations?symbol=${symbol}`, { headers: hdrs, signal: ctrl1.signal });
        if (!r1.ok) { console.error(`[options] Tradier expirations ${r1.status}`); return null; }
        const d1 = await r1.json();
        expirations = d1?.expirations?.date ?? [];
        if (!Array.isArray(expirations)) expirations = expirations ? [expirations] : [];
    } catch(e) { console.error('[options] Tradier expirations error:', e.message); return null; }

    if (!expirations.length) { console.error('[options] Tradier: no expirations for', symbol); return null; }

    // Pick expiry closest to target
    const targetMs = new Date(targetDateStr).getTime();
    const bestExpiry = expirations.reduce((a, b) => {
        const da = Math.abs(new Date(a).getTime() - targetMs);
        const db = Math.abs(new Date(b).getTime() - targetMs);
        return db < da ? b : a;
    });

    // Step 2: Get options chain for that expiry
    const ctrl2 = new AbortController();
    setTimeout(() => ctrl2.abort(), 12000);
    let contracts = [];
    try {
        const r2 = await fetch(`${base}/markets/options/chains?symbol=${symbol}&expiration=${bestExpiry}&greeks=true`, { headers: hdrs, signal: ctrl2.signal });
        if (!r2.ok) { console.error(`[options] Tradier chain ${r2.status}`); return null; }
        const d2 = await r2.json();
        const all = d2?.options?.option ?? [];
        contracts = all.filter(o => o.option_type === contractType);
    } catch(e) { console.error('[options] Tradier chain error:', e.message); return null; }

    if (!contracts.length) { console.error('[options] Tradier: no', contractType, 'contracts for', symbol, bestExpiry); return null; }

    // Find ATM contract
    const ref = currentPrice || 0;
    const best = contracts.reduce((a, b) => {
        const sa = Math.abs((parseFloat(a.strike) || 0) - ref);
        const sb = Math.abs((parseFloat(b.strike) || 0) - ref);
        return sb < sa ? b : a;
    });

    const bid  = best.bid  != null && best.bid  !== 0 ? parseFloat(best.bid)  : null;
    const ask  = best.ask  != null && best.ask  !== 0 ? parseFloat(best.ask)  : null;
    const last = best.last != null && best.last !== 0 ? parseFloat(best.last) : null;
    const iv   = best.greeks?.smv_vol != null ? parseFloat((best.greeks.smv_vol * 100).toFixed(1))
               : best.implied_volatility != null ? parseFloat((best.implied_volatility * 100).toFixed(1)) : null;
    // Tradier greeks: delta, gamma, theta, vega (from greeks=true)
    const delta = best.greeks?.delta != null ? parseFloat(best.greeks.delta.toFixed(3)) : null;
    const gamma = best.greeks?.gamma != null ? parseFloat(best.greeks.gamma.toFixed(4)) : null;
    const theta = best.greeks?.theta != null ? parseFloat(best.greeks.theta.toFixed(4)) : null;
    const vega  = best.greeks?.vega  != null ? parseFloat(best.greeks.vega.toFixed(4))  : null;

    const priceType = (bid != null || ask != null) ? 'live' : last != null ? 'last_trade' : null;
    if (priceType == null) { console.error('[options] Tradier: no price for best contract', best.symbol); return null; }

    console.log(`[options] ✓ Tradier ${symbol} ${contractType} ${bestExpiry} strike=${best.strike} bid=${bid} ask=${ask} last=${last} delta=${delta}`);

    return {
        strike:         parseFloat(best.strike),
        expiry:         bestExpiry,
        bid, ask,
        mid:            bid != null && ask != null ? parseFloat(((bid + ask) / 2).toFixed(2)) : null,
        last,
        volume:         parseInt(best.volume) || 0,
        openInterest:   parseInt(best.open_interest) || 0,
        iv,
        inTheMoney:     best.in_the_money === 'true' || best.in_the_money === true,
        contractSymbol: best.symbol ?? '',
        priceType,
        source:         'tradier',
        delta, gamma, theta, vega,
    };
}

// ── Twelve Data options chain ────────────────────────────────────────────────
// Free tier: 800 credits/day, 8 req/min. Options chain included on free plan.
async function fetchTwelvedataOptions(symbol, contractType, targetDateStr, currentPrice, apiKey) {
    // Step 1: get available expiration dates so we can pick the closest to target
    const expUrl = `https://api.twelvedata.com/options/expiration?symbol=${symbol}&apikey=${apiKey}`;
    const ctrl1 = new AbortController();
    setTimeout(() => ctrl1.abort(), 10000);

    let expirations = [];
    try {
        const r1 = await fetch(expUrl, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: ctrl1.signal });
        if (!r1.ok) {
            console.error(`[options] TwelveData expirations ${r1.status}`);
            return null;
        }
        const d1 = await r1.json();
        if (d1.code || d1.status === 'error') {
            console.error('[options] TwelveData expirations error:', d1.message?.slice(0, 120));
            return null;
        }
        // API returns { dates: [...] } or { expiration_dates: [...] }
        expirations = d1.dates ?? d1.expiration_dates ?? [];
        if (!Array.isArray(expirations)) expirations = [];
    } catch(e) {
        console.error('[options] TwelveData expirations fetch error:', e.message);
        return null;
    }

    if (!expirations.length) {
        console.error('[options] TwelveData: no expirations returned for', symbol);
        return null;
    }

    // Pick expiry closest to target date
    const targetMs = new Date(targetDateStr).getTime();
    const bestExpiry = expirations.reduce((a, b) => {
        const da = Math.abs(new Date(a).getTime() - targetMs);
        const db = Math.abs(new Date(b).getTime() - targetMs);
        return db < da ? b : a;
    });

    // Step 2: get options chain for that expiry, filtered by contract type
    const chainUrl = `https://api.twelvedata.com/options/chain?symbol=${symbol}&expiration_date=${bestExpiry}&option_type=${contractType}&apikey=${apiKey}`;
    const ctrl2 = new AbortController();
    setTimeout(() => ctrl2.abort(), 12000);

    let data;
    try {
        const r2 = await fetch(chainUrl, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: ctrl2.signal });
        if (!r2.ok) {
            console.error(`[options] TwelveData chain ${r2.status}`);
            return null;
        }
        data = await r2.json();
    } catch(e) {
        console.error('[options] TwelveData chain fetch error:', e.message);
        return null;
    }

    if (data.code || data.status === 'error') {
        console.error('[options] TwelveData chain error:', data.message?.slice(0, 120));
        return null;
    }

    // Twelve Data returns calls/puts arrays — pick the correct one
    const contracts = (contractType === 'put' ? data.puts : data.calls) ?? [];
    if (!contracts.length) {
        console.error('[options] TwelveData: no', contractType, 'contracts for', symbol, bestExpiry);
        return null;
    }

    // Find ATM contract (closest strike to current price)
    const ref = currentPrice || 0;
    const best = contracts.reduce((a, b) => {
        const sa = Math.abs(parseFloat(a.strike_price ?? a.strike) - ref);
        const sb = Math.abs(parseFloat(b.strike_price ?? b.strike) - ref);
        return sb < sa ? b : a;
    });

    const bid  = best.bid  != null && best.bid  !== '' ? parseFloat(best.bid)  : null;
    const ask  = best.ask  != null && best.ask  !== '' ? parseFloat(best.ask)  : null;
    const last = best.last_price != null && best.last_price !== '' ? parseFloat(best.last_price) : null;

    // implied_volatility from TwelveData comes as a decimal (0.35 = 35%)
    const ivRaw = best.implied_volatility;
    const iv = ivRaw != null && ivRaw !== '' ? parseFloat((parseFloat(ivRaw) * 100).toFixed(1)) : null;

    const priceType = (bid != null || ask != null) ? 'live' : last != null ? 'last_trade' : null;
    if (priceType == null) {
        console.error('[options] TwelveData: no price data for best contract', best.contract_name ?? best.strike_price);
        return null;
    }

    console.log(`[options] ✓ TwelveData ${symbol} ${contractType} ${bestExpiry} strike=${best.strike_price} bid=${bid} ask=${ask} last=${last}`);

    return {
        strike:         parseFloat(best.strike_price ?? best.strike),
        expiry:         bestExpiry,
        bid, ask,
        mid:            bid != null && ask != null ? parseFloat(((bid + ask) / 2).toFixed(2)) : null,
        last,
        volume:         parseInt(best.volume) || 0,
        openInterest:   parseInt(best.open_interest) || 0,
        iv,
        inTheMoney:     best.in_the_money === 'true' || best.in_the_money === true,
        contractSymbol: best.contract_name ?? best.symbol ?? '',
        priceType,
        source:         'twelvedata',
    };
}

// ── Finnhub options chain ────────────────────────────────────────────────────
// Free tier: 60 req/min. /stock/option-chain returns bid/ask/last per contract.
async function fetchFinnhubOptions(symbol, contractType, targetDateStr, currentPrice, apiKey) {
    const url = `https://finnhub.io/api/v1/stock/option-chain?symbol=${symbol}&token=${apiKey}`;
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 12000);

    let data;
    try {
        const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: ctrl.signal });
        if (!r.ok) {
            console.error(`[options] Finnhub ${r.status}`);
            return null;
        }
        data = await r.json();
    } catch(e) {
        console.error('[options] Finnhub fetch error:', e.message);
        return null;
    }

    if (!data.data || !data.data.length) {
        console.error('[options] Finnhub: no option data for', symbol);
        return null;
    }

    // Pick expiry closest to target date
    const targetMs = new Date(targetDateStr).getTime();
    const bestExpiry = data.data.reduce((a, b) => {
        const da = Math.abs(new Date(a.expirationDate).getTime() - targetMs);
        const db = Math.abs(new Date(b.expirationDate).getTime() - targetMs);
        return db < da ? b : a;
    });

    const key = contractType === 'put' ? 'PUT' : 'CALL';
    const contracts = bestExpiry.options?.[key] ?? [];
    if (!contracts.length) {
        console.error('[options] Finnhub: no', key, 'contracts for', symbol, bestExpiry.expirationDate);
        return null;
    }

    // Find ATM contract
    const ref = currentPrice || 0;
    const best = contracts.reduce((a, b) => {
        const sa = Math.abs((a.strike || 0) - ref);
        const sb = Math.abs((b.strike || 0) - ref);
        return sb < sa ? b : a;
    });

    const bid  = best.bid  != null ? parseFloat(best.bid)  : null;
    const ask  = best.ask  != null ? parseFloat(best.ask)  : null;
    const last = best.lastPrice != null ? parseFloat(best.lastPrice) : null;
    const iv   = best.impliedVolatility != null ? parseFloat((best.impliedVolatility * 100).toFixed(1)) : null;

    const priceType = (bid != null || ask != null) ? 'live' : last != null ? 'last_trade' : null;
    if (priceType == null) {
        console.error('[options] Finnhub: no price data for best contract strike', best.strike);
        return null;
    }

    console.log(`[options] ✓ Finnhub ${symbol} ${key} ${bestExpiry.expirationDate} strike=${best.strike} bid=${bid} ask=${ask} last=${last}`);

    return {
        strike:         parseFloat(best.strike),
        expiry:         bestExpiry.expirationDate,
        bid, ask,
        mid:            bid != null && ask != null ? parseFloat(((bid + ask) / 2).toFixed(2)) : null,
        last,
        volume:         parseInt(best.volume) || 0,
        openInterest:   parseInt(best.openInterest) || 0,
        iv,
        inTheMoney:     best.inTheMoney ?? false,
        contractSymbol: best.contractName ?? '',
        priceType,
        source:         'finnhub',
    };
}

// ── Yahoo Finance v10/quoteSummary fallback ──────────────────────────────────
const _credCache = { crumb: null, cookie: null, expires: 0 };

async function getYahooCreds() {
    const now = Date.now();
    if (_credCache.crumb && now < _credCache.expires) return _credCache;
    try {
        const r1 = await fetch('https://finance.yahoo.com', {
            headers: { 'User-Agent': UA, 'Accept': 'text/html' }, redirect: 'follow',
        });
        const pairs = [];
        r1.headers.forEach((v, k) => {
            if (k.toLowerCase() === 'set-cookie') { const p = v.split(';')[0]; if (p) pairs.push(p); }
        });
        const cookieStr = pairs.join('; ');
        const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
            headers: { 'User-Agent': UA, 'Cookie': cookieStr, 'Referer': 'https://finance.yahoo.com/' },
        });
        const crumb = r2.ok ? (await r2.text()).trim() : null;
        if (crumb && !crumb.includes('<')) {
            _credCache.crumb = crumb; _credCache.cookie = cookieStr; _credCache.expires = Date.now() + 25 * 60 * 1000;
        }
        return { crumb: _credCache.crumb, cookie: cookieStr };
    } catch(e) { return null; }
}

async function fetchYahooV10Options(symbol, contractType, expiryDays) {
    const creds = await getYahooCreds();
    const hdrs  = {
        'User-Agent': UA, 'Accept': 'application/json, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://finance.yahoo.com/', 'Origin': 'https://finance.yahoo.com',
        ...(creds?.cookie ? { 'Cookie': creds.cookie } : {}),
    };
    const crumbQ = creds?.crumb ? `&crumb=${encodeURIComponent(creds.crumb)}` : '';

    for (const host of ['query2', 'query1']) {
        try {
            const url1 = `https://${host}.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=optionChain${crumbQ}`;
            const c1 = new AbortController(); setTimeout(() => c1.abort(), 10000);
            const r1 = await fetch(url1, { headers: hdrs, signal: c1.signal });
            if (!r1.ok) { console.error(`[options] Yahoo v10 ${host} base ${r1.status}`); continue; }
            const d1 = await r1.json();
            const oc1 = d1?.quoteSummary?.result?.[0]?.optionChain;
            if (!oc1?.expirationDates?.length) { console.error(`[options] Yahoo v10 ${host} no optionChain`); continue; }

            const now = Math.floor(Date.now() / 1000);
            const idealTs = now + expiryDays * 86400;
            const future = oc1.expirationDates.filter(t => t > now);
            if (!future.length) continue;
            const targetTs = future.reduce((a, b) => Math.abs(b - idealTs) < Math.abs(a - idealTs) ? b : a);
            const currentPrice = oc1.quote?.regularMarketPrice || 0;

            const url2 = `https://${host}.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=optionChain&date=${targetTs}${crumbQ}`;
            const c2 = new AbortController(); setTimeout(() => c2.abort(), 10000);
            const r2 = await fetch(url2, { headers: hdrs, signal: c2.signal });
            if (!r2.ok) { console.error(`[options] Yahoo v10 ${host} chain ${r2.status}`); continue; }
            const d2 = await r2.json();
            const oc2 = d2?.quoteSummary?.result?.[0]?.optionChain;
            if (!oc2) continue;

            const entry = oc2.options?.find(o => Math.abs(o.expirationDate - targetTs) < 86400) || oc2.options?.[0];
            if (!entry) continue;
            const contracts = entry[contractType === 'put' ? 'puts' : 'calls'] || [];
            if (!contracts.length) continue;

            const expDateStr = new Date(targetTs * 1000).toISOString().split('T')[0];
            const best = contracts.reduce((a, b) => Math.abs(b.strike - currentPrice) < Math.abs(a.strike - currentPrice) ? b : a);

            console.log(`[options] ✓ Yahoo v10 ${host} ${symbol} ${contractType} ${expDateStr} strike=$${best.strike} bid=$${best.bid} ask=$${best.ask}`);
            return {
                strike: best.strike, expiry: expDateStr,
                bid: best.bid ?? null, ask: best.ask ?? null,
                mid: best.bid != null && best.ask != null ? parseFloat(((best.bid + best.ask) / 2).toFixed(2)) : null,
                last: best.lastPrice ?? null, volume: best.volume ?? 0,
                openInterest: best.openInterest ?? 0,
                iv: best.impliedVolatility != null ? parseFloat((best.impliedVolatility * 100).toFixed(1)) : null,
                inTheMoney: best.inTheMoney ?? false,
                contractSymbol: best.contractSymbol ?? '',
                source: 'yahoo_v10',
            };
        } catch(e) { console.error(`[options] Yahoo v10 ${host} error:`, e.message); }
    }
    return null;
}

// ── Main handler ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    const { ticker, type = 'call', strike, expiry = '30d' } = req.query;
    if (!ticker) return res.status(400).json({ error: 'ticker required' });

    const symbol       = ticker.toUpperCase().trim();
    const contractType = type.toLowerCase() === 'put' ? 'put' : 'call';
    const targetStrike = parseFloat(strike) || null;

    const now = Math.floor(Date.now() / 1000);
    let targetDateStr;
    if (expiry.match(/^\d{4}-\d{2}-\d{2}$/)) {
        targetDateStr = expiry;
    } else {
        const days = expiry === '1w' ? 7 : expiry === '90d' ? 90 : expiry === '180d' ? 180 : 30;
        targetDateStr = new Date((now + days * 86400) * 1000).toISOString().split('T')[0];
    }
    const expiryDays = Math.round((new Date(targetDateStr).getTime() / 1000 - now) / 86400);

    // Get current price for ATM strike selection
    // Try Polygon snapshot first (reliable from Vercel), fall back to Yahoo
    let currentPrice = 0;
    const _priceKey = process.env.MASSIVE_API_KEY;
    if (_priceKey) {
        try {
            const snapR = await fetch(
                `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${symbol}?apiKey=${_priceKey}`,
                { headers: { 'User-Agent': UA, 'Accept': 'application/json' } }
            );
            if (snapR.ok) {
                const snapD = await snapR.json();
                const t = snapD?.ticker;
                currentPrice = t?.day?.c || t?.lastTrade?.p || t?.prevDay?.c || 0;
                if (currentPrice) console.log(`[options] price from Polygon snapshot: ${symbol} = $${currentPrice}`);
            }
        } catch(e) {}
    }
    if (!currentPrice) {
        try {
            const qr = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&range=1d`, {
                headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com/' },
            });
            if (qr.ok) {
                const qd = await qr.json();
                currentPrice = qd?.chart?.result?.[0]?.meta?.regularMarketPrice || 0;
                if (currentPrice) console.log(`[options] price from Yahoo fallback: ${symbol} = $${currentPrice}`);
            }
        } catch(e) {}
    }
    if (!currentPrice) console.error(`[options] WARNING: could not get current price for ${symbol} — ATM selection will be wrong`);

    const refPrice = targetStrike || currentPrice;

    // ── Cache check ───────────────────────────────────────────────────
    const cKey = _cacheKey(symbol, contractType, targetDateStr);
    const cached = _cacheGet(cKey);
    if (cached) {
        console.log(`[options] cache hit for ${symbol} ${contractType} ${targetDateStr}`);
        return res.status(200).json({ ...cached, fromCache: true });
    }

    try {
        // Helper to build, cache, and return a successful response
        const respond = (result, source) => {
            const payload = {
                ticker: symbol, contractType, currentPrice,
                targetExpiry: result.expiry,
                best: {
                    strike: result.strike, expiry: result.expiry,
                    bid: result.bid, ask: result.ask, mid: result.mid,
                    last: result.last, volume: result.volume,
                    openInterest: result.openInterest ?? result.oi, iv: result.iv,
                    inTheMoney: result.inTheMoney, contractSymbol: result.contractSymbol ?? result.ticker ?? '',
                    priceType: result.priceType,
                },
                fetchedAt: new Date().toISOString(),
                source,
            };
            _cacheSet(cKey, payload);
            return res.status(200).json(payload);
        };

        // ── Source 1: Massive (Polygon — MASSIVE_API_KEY) ────────────
        const massiveKey = process.env.MASSIVE_API_KEY;
        if (massiveKey) {
            const result = await fetchMassiveOptions(symbol, contractType, targetDateStr, refPrice, massiveKey);
            if (result) return respond(result, 'massive');
            console.warn('[options] Massive failed, trying Tradier');
        }

        // ── Source 2: Tradier (TRADIER_API_KEY) ───────────────────────
        const tradierKey = process.env.TRADIER_API_KEY;
        if (tradierKey) {
            const result = await fetchTradierOptions(symbol, contractType, targetDateStr, refPrice, tradierKey);
            if (result) return respond(result, 'tradier');
            console.warn('[options] Tradier failed, trying Twelve Data');
        }

        // ── Source 3: Twelve Data (TWELVEDATA_API_KEY) ────────────────
        const twelvedataKey = process.env.TWELVEDATA_API_KEY;
        if (twelvedataKey) {
            const result = await fetchTwelvedataOptions(symbol, contractType, targetDateStr, refPrice, twelvedataKey);
            if (result) return respond(result, 'twelvedata');
            console.warn('[options] TwelveData failed, trying Finnhub');
        }

        // ── Source 4: Finnhub (FINNHUB_API_KEY) ───────────────────────
        const finnhubKey = process.env.FINNHUB_API_KEY;
        if (finnhubKey) {
            const result = await fetchFinnhubOptions(symbol, contractType, targetDateStr, refPrice, finnhubKey);
            if (result) return respond(result, 'finnhub');
            console.warn('[options] Finnhub failed, trying Yahoo v10 fallback');
        }

        // ── Source 5: Yahoo Finance v10/quoteSummary (no key needed) ─
        const yahooResult = await fetchYahooV10Options(symbol, contractType, expiryDays);
        if (yahooResult) return respond(yahooResult, 'yahoo_v10');

        return res.status(502).json({
            error: `Options data unavailable for ${symbol}. All sources failed (Polygon, Tradier, Twelve Data, Finnhub, Yahoo).`,
            hint: 'Check Vercel logs for source-specific errors. Polygon free tier does not include options — upgrade or use another source.'
        });

    } catch(err) {
        console.error('[options] handler error:', err.message);
        return res.status(500).json({ error: err.message });
    }
};
