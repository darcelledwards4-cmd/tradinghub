/**
 * /api/news?ticker=AAPL
 *
 * Returns recent news articles for a ticker.
 * Strategy:
 *   1. Finnhub (server-side, FINNHUB_API_KEY env var) — best quality
 *   2. Yahoo Finance RSS (server-side, no key needed) — reliable fallback
 *
 * Response: { ticker, articles: [{ headline, source, url, datetime }], _source }
 */

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { ticker } = req.query;
    if (!ticker) return res.status(400).json({ error: 'ticker required' });

    const sym = ticker.toUpperCase().trim();

    // ── 1. Finnhub (best quality, requires API key) ────────────────────────────
    const fhKey = process.env.FINNHUB_API_KEY;
    if (fhKey) {
        try {
            const to   = fmt(new Date());
            const from = fmt(new Date(Date.now() - 7 * 86400000));
            const url  = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(sym)}&from=${from}&to=${to}&token=${fhKey}`;
            const data = await fetchJSON(url, 8000);

            if (Array.isArray(data) && data.length > 0) {
                const articles = data
                    .filter(a => a.headline && a.headline.length > 5)
                    .slice(0, 6)
                    .map(a => ({
                        headline: a.headline,
                        source:   a.source   || 'Finnhub',
                        url:      a.url      || '#',
                        datetime: a.datetime || 0,
                    }));
                if (articles.length > 0) {
                    return res.status(200).json({ ticker: sym, articles, _source: 'finnhub' });
                }
            }
        } catch (e) {
            console.warn('[news] Finnhub failed:', e.message);
        }
    }

    // ── 2. Yahoo Finance RSS (no key needed — works server-side, no CORS) ──────
    try {
        const rssUrl = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(sym)}&region=US&lang=en-US`;
        const text   = await fetchText(rssUrl, 8000);
        const articles = parseRss(text, 'Yahoo Finance');
        if (articles.length > 0) {
            return res.status(200).json({ ticker: sym, articles: articles.slice(0, 6), _source: 'yahoo_rss' });
        }
    } catch (e) {
        console.warn('[news] Yahoo RSS failed:', e.message);
    }

    // ── 3. Google News RSS (broader coverage, last resort) ────────────────────
    try {
        const q      = encodeURIComponent(`${sym} stock`);
        const rssUrl = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
        const text   = await fetchText(rssUrl, 8000);
        const articles = parseRss(text, 'Google News');
        if (articles.length > 0) {
            return res.status(200).json({ ticker: sym, articles: articles.slice(0, 6), _source: 'google_news' });
        }
    } catch (e) {
        console.warn('[news] Google News RSS failed:', e.message);
    }

    return res.status(200).json({ ticker: sym, articles: [], _source: 'none' });
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmt(d) { return d.toISOString().split('T')[0]; }

async function fetchJSON(url, timeoutMs = 8000) {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const r = await fetch(url, { signal: ctrl.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
    } finally { clearTimeout(tid); }
}

async function fetchText(url, timeoutMs = 8000) {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const r = await fetch(url, {
            signal: ctrl.signal,
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TradingHub/1.0)' },
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.text();
    } finally { clearTimeout(tid); }
}

function parseRss(xmlText, defaultSource) {
    // Simple regex-based XML parser — no DOM available in Node
    const items = [];
    const itemRx = /<item>([\s\S]*?)<\/item>/gi;
    let match;
    while ((match = itemRx.exec(xmlText)) !== null) {
        const block   = match[1];
        const title   = stripCdata(tag(block, 'title'));
        const link    = stripCdata(tag(block, 'link')) || stripCdata(tag(block, 'guid'));
        const pubDate = stripCdata(tag(block, 'pubDate'));
        const src     = stripCdata(tag(block, 'source')) || defaultSource;
        if (!title || title.length < 5) continue;
        // Strip publisher suffix (e.g. " - Reuters" at end of Google News titles)
        const lastDash = title.lastIndexOf(' - ');
        const headline = lastDash > 20 ? title.slice(0, lastDash).trim() : title;
        const datetime = pubDate ? Math.floor(new Date(pubDate).getTime() / 1000) : 0;
        items.push({ headline, source: src, url: link || '#', datetime });
    }
    return items;
}

function tag(str, name) {
    const rx = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i');
    const m  = rx.exec(str);
    return m ? m[1].trim() : '';
}

function stripCdata(str) {
    return str.replace(/<!\[CDATA\[|\]\]>/g, '').trim();
}
