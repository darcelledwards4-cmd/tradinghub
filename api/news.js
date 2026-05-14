/**
 * /api/news?ticker=AAPL
 *
 * Returns recent news articles for a ticker, server-side via Finnhub.
 * Runs on Vercel with FINNHUB_API_KEY env var — no browser CORS issues,
 * no third-party proxy services that go down randomly.
 *
 * Response: { ticker, articles: [{ headline, source, url, datetime }] }
 *
 * Requires: FINNHUB_API_KEY
 */

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { ticker } = req.query;
    if (!ticker) return res.status(400).json({ error: 'ticker required' });

    const sym   = ticker.toUpperCase().trim();
    const fhKey = process.env.FINNHUB_API_KEY;

    if (!fhKey) return res.status(500).json({ error: 'FINNHUB_API_KEY not set', articles: [] });

    const to   = fmt(new Date());
    const from = fmt(new Date(Date.now() - 7 * 86400000)); // last 7 days

    try {
        const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(sym)}&from=${from}&to=${to}&token=${fhKey}`;
        const data = await fetchJSON(url);

        if (!Array.isArray(data)) {
            return res.status(200).json({ ticker: sym, articles: [] });
        }

        const articles = data
            .filter(a => a.headline && a.headline.length > 5)
            .slice(0, 6)
            .map(a => ({
                headline: a.headline,
                source:   a.source || 'Finnhub',
                url:      a.url    || '#',
                datetime: a.datetime || 0,
            }));

        return res.status(200).json({ ticker: sym, articles });
    } catch (e) {
        return res.status(200).json({ ticker: sym, articles: [], error: e.message });
    }
};

function fmt(d) { return d.toISOString().split('T')[0]; }

async function fetchJSON(url) {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 10000);
    try {
        const r = await fetch(url, { signal: ctrl.signal });
        return await r.json();
    } finally { clearTimeout(tid); }
}
