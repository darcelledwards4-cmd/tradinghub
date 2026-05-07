// Real-time stock quote proxy via Yahoo Finance
// No API key required — returns live prices during market hours
module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    // Never cache price data
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    const { symbol } = req.query;
    if (!symbol) return res.status(400).json({ error: 'symbol query param required' });

    try {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 6000);

        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol.toUpperCase())}?interval=1m&range=1d`;

        const r = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json',
                'Accept-Language': 'en-US,en;q=0.9',
            },
            signal: controller.signal
        });

        if (!r.ok) {
            const body = await r.text();
            return res.status(502).json({ error: `Yahoo Finance error ${r.status}: ${body.slice(0,200)}` });
        }

        const data = await r.json();
        const result = data?.chart?.result?.[0];
        if (!result) return res.status(502).json({ error: 'No result from Yahoo Finance' });

        const meta = result.meta;
        // regularMarketPrice = live price during hours, previousClose = after hours fallback
        const price     = meta.regularMarketPrice ?? meta.previousClose ?? 0;
        const prevClose = meta.previousClose ?? meta.chartPreviousClose ?? price;
        const pctChange = prevClose && prevClose !== 0
            ? parseFloat(((price - prevClose) / prevClose * 100).toFixed(2))
            : 0;

        return res.status(200).json({
            c:  price,                                   // current price
            pc: prevClose,                               // previous close
            dp: pctChange,                               // % change
            h:  meta.regularMarketDayHigh ?? price,      // day high
            l:  meta.regularMarketDayLow  ?? price,      // day low
            t:  meta.regularMarketTime ?? null,          // unix timestamp of last update
            source: 'yahoo'
        });

    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};
