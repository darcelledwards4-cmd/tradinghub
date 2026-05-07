// Batch real-time quotes via Twelve Data
// GET /api/tdquotes?symbols=NVDA,AAPL,SPY
// Returns: { prices: { NVDA: { c, pc, dp, h, l }, ... }, fetched_at, source }
module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    const key = process.env.TWELVEDATA_API_KEY;
    if (!key) return res.status(500).json({ error: 'TWELVEDATA_API_KEY not set in Vercel environment variables' });

    const raw = (req.query.symbols || '').toUpperCase();
    if (!raw) return res.status(400).json({ error: 'symbols required' });

    const tickers = [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))].slice(0, 20);

    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);

        // Twelve Data batch quote — comma-separated symbols in single call
        const url = `https://api.twelvedata.com/quote?symbol=${tickers.join(',')}&apikey=${key}`;
        const r = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);

        if (!r.ok) {
            const body = await r.text();
            return res.status(502).json({ error: `Twelve Data HTTP ${r.status}: ${body.slice(0,200)}` });
        }

        const data = await r.json();

        // Top-level error (e.g. bad API key, rate limit exceeded)
        if (data.code && data.message) {
            return res.status(502).json({ error: `Twelve Data error ${data.code}: ${data.message}` });
        }

        const priceMap = {};

        // Single ticker → quote object directly; multiple → { TICKER: quote, ... }
        const entries = tickers.length === 1
            ? [[tickers[0], data]]
            : Object.entries(data);

        for (const [ticker, q] of entries) {
            // Skip error entries or missing data
            if (!q || q.code || q.status === 'error' || !q.close) continue;

            const price     = parseFloat(q.close);
            const prevClose = parseFloat(q.previous_close || q.close);
            const pct       = prevClose
                ? parseFloat(((price - prevClose) / prevClose * 100).toFixed(2))
                : parseFloat(q.percent_change || 0);

            priceMap[ticker.toUpperCase()] = {
                c:  price,
                pc: prevClose,
                dp: pct,
                h:  parseFloat(q.high  || price),
                l:  parseFloat(q.low   || price),
            };
        }

        return res.status(200).json({
            prices:     priceMap,
            fetched_at: new Date().toISOString(),
            count:      Object.keys(priceMap).length,
            requested:  tickers.length,
            source:     'twelvedata',
        });

    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};
