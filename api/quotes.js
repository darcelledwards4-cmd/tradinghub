// Batch real-time quotes via Yahoo Finance — no API key, no delay
// GET /api/quotes?symbols=NVDA,AAPL,SPY,QQQ (up to 20 symbols)
// Returns: { NVDA: { c, pc, dp, h, l }, AAPL: {...}, ... }
module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    const raw = (req.query.symbols || '').toUpperCase();
    if (!raw) return res.status(400).json({ error: 'symbols required' });

    const tickers = [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))].slice(0, 20);

    // Fetch one symbol from Yahoo Finance v8 chart
    async function fetchOne(ticker) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 7000);
        try {
            const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=1d&includePrePost=false`;
            const r = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'Accept': 'application/json, text/plain, */*',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Referer': 'https://finance.yahoo.com/',
                    'Origin': 'https://finance.yahoo.com',
                },
                signal: controller.signal
            });
            if (!r.ok) return null;
            const data = await r.json();
            const meta = data?.chart?.result?.[0]?.meta;
            if (!meta || !meta.regularMarketPrice) return null;
            const price    = meta.regularMarketPrice;
            const prevClose = meta.previousClose || meta.chartPreviousClose || price;
            const pct = prevClose ? parseFloat(((price - prevClose) / prevClose * 100).toFixed(2)) : 0;
            return {
                c:  price,
                pc: prevClose,
                dp: pct,
                h:  meta.regularMarketDayHigh || price,
                l:  meta.regularMarketDayLow  || price,
            };
        } catch (e) {
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    // Fetch in parallel — Yahoo Finance handles concurrent requests fine from a single IP
    // when proper headers are set. Limit to 20 symbols to stay within Vercel 10s timeout.
    const results = await Promise.allSettled(tickers.map(fetchOne));

    const priceMap = {};
    tickers.forEach((ticker, i) => {
        const r = results[i];
        if (r.status === 'fulfilled' && r.value) {
            priceMap[ticker] = r.value;
        }
    });

    return res.status(200).json({
        prices: priceMap,
        fetched_at: new Date().toISOString(),
        count: Object.keys(priceMap).length,
        requested: tickers.length,
    });
};
