module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');

    const BROWSER_HEADERS = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://housestockwatcher.com/',
        'Origin': 'https://housestockwatcher.com'
    };

    async function tryFetch(url) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        try {
            const r = await fetch(url, { headers: BROWSER_HEADERS, signal: controller.signal });
            if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
            return await r.json();
        } finally {
            clearTimeout(timer);
        }
    }

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);

    // Try multiple URL variants for each chamber
    const HOUSE_URLS = [
        'https://house-stock-watcher-data.s3-us-west-2.amazonaws.com/data/all_transactions.json',
        'https://house-stock-watcher-data.s3.amazonaws.com/data/all_transactions.json',
    ];
    const SENATE_URLS = [
        'https://senate-stock-watcher-data.s3-us-west-2.amazonaws.com/aggregate/all_transactions.json',
        'https://senate-stock-watcher-data.s3.amazonaws.com/aggregate/all_transactions.json',
    ];

    async function tryMultiple(urls) {
        for (const url of urls) {
            try { return await tryFetch(url); } catch (e) { /* try next */ }
        }
        throw new Error('All URLs failed for this chamber');
    }

    const [houseResult, senateResult] = await Promise.allSettled([
        tryMultiple(HOUSE_URLS),
        tryMultiple(SENATE_URLS)
    ]);

    const mapHouse = t => ({
        chamber: 'House',
        member: t.representative || 'Unknown',
        party: t.party || '',
        ticker: (t.ticker || '').toUpperCase().trim(),
        asset: (t.asset_description || '').slice(0, 80),
        type: t.type || '',
        amount: t.amount || '',
        trade_date: t.transaction_date,
        disclosure_date: t.disclosure_date || '',
        district: t.district || ''
    });

    const mapSenate = t => ({
        chamber: 'Senate',
        member: t.senator || 'Unknown',
        party: t.party || '',
        ticker: (t.ticker || '').toUpperCase().trim(),
        asset: (t.asset_description || t.asset_name || '').slice(0, 80),
        type: t.type || '',
        amount: t.amount || '',
        trade_date: t.transaction_date,
        disclosure_date: t.disclosure_date || '',
        district: t.state || ''
    });

    const filter = t =>
        t.ticker && t.ticker !== '--' && t.ticker.length <= 6 &&
        t.trade_date && new Date(t.trade_date) >= cutoff;

    const houseTrades = houseResult.status === 'fulfilled'
        ? (Array.isArray(houseResult.value) ? houseResult.value : []).filter(filter).slice(0, 80).map(mapHouse)
        : [];

    const senateTrades = senateResult.status === 'fulfilled'
        ? (Array.isArray(senateResult.value) ? senateResult.value : []).filter(filter).slice(0, 80).map(mapSenate)
        : [];

    const errors = [
        houseResult.status === 'rejected' ? 'House: ' + houseResult.reason?.message : null,
        senateResult.status === 'rejected' ? 'Senate: ' + senateResult.reason?.message : null
    ].filter(Boolean);

    if (!houseTrades.length && !senateTrades.length) {
        return res.status(502).json({
            error: 'Data sources unavailable: ' + errors.join(' | '),
            trades: [],
            debug: { houseError: houseResult.reason?.message, senateError: senateResult.reason?.message }
        });
    }

    const combined = [...houseTrades, ...senateTrades]
        .sort((a, b) => new Date(b.trade_date) - new Date(a.trade_date))
        .slice(0, 60);

    return res.status(200).json({
        trades: combined,
        fetched_at: new Date().toISOString(),
        warnings: errors.length ? errors : undefined
    });
};
