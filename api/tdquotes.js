// Batch real-time quotes via Twelve Data
// GET /api/tdquotes?symbols=NVDA,AAPL,SPY
// Returns: { prices: { NVDA: { c, pc, dp, h, l }, ... }, fetched_at }
module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    const key = process.env.TWELVEDATA_API_KEY;
    if (!key) return res.status(500).json({ error: 'TWELVEDATA_API_KEY not set in Vercel environment variables' });

    const raw = (req.query.symbols || '').toUpperCase();
    if (!raw) return res.status(400).json({ error: 'symbols required' });

    const tickers = [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))].slice(0, 20);

    try {
        // Twelve Data supports comma-separated batch quotes in one call
        const url = `https://api.twelvedata.com/quote?symbol=${tickers.join(',')}&apikey=${key}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);

        const r = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);

        if (!r.ok) return res.status(502).json({ error: `Twelve Data error ${r.status}` });
        const data = await r.json();

        const priceMap = {};

        // Single ticker returns an object; multiple tickers returns { TICKER: {...}, ... }
        const isSingle = tickers.length === 1;
        const entries = isSingle ? [[tickers[0], data]] : Object.entries(data);

        for (const [ticker, q] of entries) {
            if (!q || q.status === 'error' || !q.close) continue;
            const price = parseFloat(q.close);
            const prevClose = parseFloat(q.previous_close || q.close);
            const pct = prevClose ? parseFloat(((price - prevClose) / prevClose * 100).toFixed(2)) : 0;
            priceMap[ticker] = {
                c:  price,
                pc: prevClose,
                dp: pct,
                h:  parseFloat(q.high || price),
                l:  parseFloat(q.low  || price),
            };
        }

        return res.status(200).json({
            prices: priceMap,
            fetched_at: new Date().toISOString(),
            count: Object.keys(priceMap).length,
            requested: tickers.length,
        });

    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};
