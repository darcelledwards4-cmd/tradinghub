/**
 * /api/debug-options?ticker=NVDA&type=call&expiry=2025-07-18&strike=130
 *
 * Returns the raw Polygon options snapshot for ONE contract so you can
 * verify exactly what fields (including greeks) Polygon is sending back.
 * Remove or password-protect this endpoint in production if desired.
 */
module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { ticker, type = 'call', expiry, strike } = req.query;
    if (!ticker || !expiry) {
        return res.status(400).json({ error: 'ticker and expiry required. Example: ?ticker=NVDA&type=call&expiry=2025-07-18&strike=130' });
    }

    const sym          = ticker.toUpperCase().trim();
    const contractType = type.toLowerCase() === 'put' ? 'put' : 'call';
    const polyKey      = process.env.MASSIVE_API_KEY;
    if (!polyKey) return res.status(500).json({ error: 'MASSIVE_API_KEY not set' });

    const targetMs  = new Date(expiry).getTime();
    const fromDate  = new Date(targetMs - 14 * 86400 * 1000).toISOString().split('T')[0];
    const toDate    = new Date(targetMs + 14 * 86400 * 1000).toISOString().split('T')[0];
    const strikeNum = parseFloat(strike) || null;

    let strikeMin = '', strikeMax = '';
    if (strikeNum) {
        strikeMin = `&strike_price.gte=${(strikeNum * 0.90).toFixed(2)}`;
        strikeMax = `&strike_price.lte=${(strikeNum * 1.10).toFixed(2)}`;
    }

    const url = [
        `https://api.polygon.io/v3/snapshot/options/${sym}`,
        `?contract_type=${contractType}`,
        `&expiration_date.gte=${fromDate}`,
        `&expiration_date.lte=${toDate}`,
        strikeMin, strikeMax,
        `&limit=10&order=asc&sort=strike_price`,
        `&apiKey=${polyKey}`,
    ].join('');

    try {
        const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
        const data = await r.json();

        const results = data.results || [];
        const summary = results.map(opt => ({
            ticker:      opt.details?.ticker,
            strike:      opt.details?.strike_price,
            expiry:      opt.details?.expiration_date,
            contract_type: opt.details?.contract_type,
            // Price fields
            bid:         opt.last_quote?.bid,
            ask:         opt.last_quote?.ask,
            last:        opt.last_trade?.price,
            day_close:   opt.day?.close,
            iv:          opt.implied_volatility,
            open_interest: opt.open_interest,
            // Greeks — this is what we need to verify
            greeks:      opt.greeks ?? 'MISSING',
            // All top-level keys so you can see the full structure
            all_keys:    Object.keys(opt),
        }));

        return res.status(200).json({
            query: { sym, contractType, expiry, strike: strikeNum, fromDate, toDate },
            total_results: results.length,
            polygon_status: data.status,
            contracts: summary,
            _note: 'If greeks shows MISSING, Polygon is not returning them for this plan/endpoint. Check your plan at polygon.io/dashboard.'
        });
    } catch(e) {
        return res.status(500).json({ error: e.message });
    }
};
