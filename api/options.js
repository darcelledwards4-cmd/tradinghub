// Real-time options chain via Yahoo Finance — no API key required
// GET /api/options?ticker=NVDA&type=call&strike=900&expiry=30d
//
// strike: approximate target strike (will snap to nearest real strike in chain)
// expiry: "1w" = nearest weekly, "30d" = ~30 days out, "60d" = ~60 days out
//         also accepts a specific date like "2025-06-20"
//
// Returns the best matching contract with real bid/ask/last/IV/OI

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    const { ticker, type = 'call', strike, expiry = '30d' } = req.query;
    if (!ticker) return res.status(400).json({ error: 'ticker required' });

    const symbol = ticker.toUpperCase().trim();
    const contractType = type.toLowerCase() === 'put' ? 'put' : 'call';
    const targetStrike = parseFloat(strike) || null;

    const headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://finance.yahoo.com/',
        'Origin': 'https://finance.yahoo.com',
    };

    try {
        // Step 1: Get current price + available expiry dates
        // Try query2 first, fall back to query1 if it fails
        const ctrl1 = new AbortController();
        setTimeout(() => ctrl1.abort(), 8000);
        let baseRes, baseUrl;
        for (const host of ['query2', 'query1']) {
            baseUrl = `https://${host}.finance.yahoo.com/v7/finance/options/${symbol}`;
            try {
                baseRes = await fetch(baseUrl, { headers, signal: ctrl1.signal });
                if (baseRes.ok) break;
                const body = await baseRes.text().catch(() => '');
                console.error(`[options] ${host} status ${baseRes.status}:`, body.slice(0, 200));
            } catch(e) {
                console.error(`[options] ${host} fetch error:`, e.message);
                baseRes = null;
            }
        }
        if (!baseRes || !baseRes.ok) {
            return res.status(502).json({ error: `Yahoo options unavailable for ${symbol}` });
        }

        const baseData = await baseRes.json();
        const optResult = baseData?.optionChain?.result?.[0];
        if (!optResult) return res.status(502).json({ error: 'No options data from Yahoo' });

        const currentPrice = optResult.quote?.regularMarketPrice || 0;
        const expiryDates  = optResult.expirationDates || []; // unix timestamps

        if (!expiryDates.length) return res.status(502).json({ error: 'No expiry dates available' });

        // Step 2: Pick target expiry date from available options
        const now = Math.floor(Date.now() / 1000);
        let targetTs;

        if (expiry.match(/^\d{4}-\d{2}-\d{2}$/)) {
            // Specific date — find nearest available
            const targetUnix = Math.floor(new Date(expiry).getTime() / 1000);
            targetTs = expiryDates.reduce((a, b) =>
                Math.abs(b - targetUnix) < Math.abs(a - targetUnix) ? b : a
            );
        } else if (expiry === '1w') {
            // Nearest weekly (within 14 days)
            const cutoff = now + 14 * 86400;
            const weeklies = expiryDates.filter(d => d >= now && d <= cutoff);
            targetTs = weeklies.length ? weeklies[0] : expiryDates.find(d => d > now) || expiryDates[0];
        } else {
            // "30d", "60d", etc. — find nearest to N days out
            const days = parseInt(expiry) || 30;
            const idealTs = now + days * 86400;
            const future = expiryDates.filter(d => d > now);
            if (!future.length) return res.status(502).json({ error: 'No future expiry dates' });
            targetTs = future.reduce((a, b) =>
                Math.abs(b - idealTs) < Math.abs(a - idealTs) ? b : a
            );
        }

        const expiryDateStr = new Date(targetTs * 1000).toISOString().split('T')[0];

        // Step 3: Fetch options chain for that expiry
        const ctrl2 = new AbortController();
        setTimeout(() => ctrl2.abort(), 8000);
        const chainRes = await fetch(`${baseUrl}?date=${targetTs}`, { headers, signal: ctrl2.signal });
        if (!chainRes.ok) return res.status(502).json({ error: `Chain fetch error ${chainRes.status}` });

        const chainData = await chainRes.json();
        const chainResult = chainData?.optionChain?.result?.[0];
        if (!chainResult) return res.status(502).json({ error: 'No chain result' });

        const contracts = chainResult.options?.[0]?.[contractType === 'call' ? 'calls' : 'puts'] || [];
        if (!contracts.length) return res.status(502).json({ error: `No ${contractType}s available for ${expiryDateStr}` });

        // Step 4: Pick best strike
        // Default to ATM (closest to current price) or to target strike if provided
        const refStrike = targetStrike || currentPrice;
        const best = contracts.reduce((a, b) =>
            Math.abs(b.strike - refStrike) < Math.abs(a.strike - refStrike) ? b : a
        );

        // Also grab the next strike OTM so caller can compare
        const otmContracts = contracts.filter(c =>
            contractType === 'call' ? c.strike > best.strike : c.strike < best.strike
        );
        const nextOtm = otmContracts.length
            ? otmContracts.reduce((a, b) =>
                Math.abs(b.strike - best.strike) < Math.abs(a.strike - best.strike) ? b : a
              )
            : null;

        function formatContract(c) {
            if (!c) return null;
            return {
                strike:          c.strike,
                expiry:          expiryDateStr,
                bid:             c.bid   ?? null,
                ask:             c.ask   ?? null,
                last:            c.lastPrice ?? null,
                mid:             (c.bid != null && c.ask != null) ? parseFloat(((c.bid + c.ask) / 2).toFixed(2)) : null,
                volume:          c.volume ?? 0,
                openInterest:    c.openInterest ?? 0,
                iv:              c.impliedVolatility != null ? parseFloat((c.impliedVolatility * 100).toFixed(1)) : null,
                inTheMoney:      c.inTheMoney ?? false,
                contractSymbol:  c.contractSymbol ?? '',
            };
        }

        return res.status(200).json({
            ticker:        symbol,
            contractType,
            currentPrice,
            targetExpiry:  expiryDateStr,
            best:          formatContract(best),
            nextOtm:       formatContract(nextOtm),
            allStrikes:    contracts.map(c => ({
                strike:   c.strike,
                bid:      c.bid   ?? null,
                ask:      c.ask   ?? null,
                last:     c.lastPrice ?? null,
                volume:   c.volume ?? 0,
                oi:       c.openInterest ?? 0,
                itm:      c.inTheMoney ?? false,
            })),
            availableExpiries: expiryDates.map(ts => new Date(ts * 1000).toISOString().split('T')[0]),
            fetchedAt: new Date().toISOString(),
            source: 'yahoo_finance',
        });

    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};
