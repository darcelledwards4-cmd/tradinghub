module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');

    const TIMEOUT_MS = 8000;

    async function fetchWithTimeout(url) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
            const r = await fetch(url, { signal: controller.signal });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return await r.json();
        } finally {
            clearTimeout(timer);
        }
    }

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);

    let houseTrades = [];
    let senateTrades = [];
    const errors = [];

    // --- HOUSE ---
    try {
        const raw = await fetchWithTimeout(
            'https://house-stock-watcher-data.s3-us-west-2.amazonaws.com/data/all_transactions.json'
        );
        houseTrades = (Array.isArray(raw) ? raw : [])
            .filter(t =>
                t.ticker && t.ticker !== '--' && t.ticker.length <= 6 &&
                t.transaction_date && new Date(t.transaction_date) >= cutoff
            )
            .slice(0, 80)
            .map(t => ({
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
            }));
    } catch (e) {
        errors.push('House data: ' + e.message);
    }

    // --- SENATE ---
    try {
        const raw = await fetchWithTimeout(
            'https://senate-stock-watcher-data.s3-us-west-2.amazonaws.com/aggregate/all_transactions.json'
        );
        senateTrades = (Array.isArray(raw) ? raw : [])
            .filter(t =>
                t.ticker && t.ticker !== '--' && t.ticker.length <= 6 &&
                t.transaction_date && new Date(t.transaction_date) >= cutoff
            )
            .slice(0, 80)
            .map(t => ({
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
            }));
    } catch (e) {
        errors.push('Senate data: ' + e.message);
    }

    if (!houseTrades.length && !senateTrades.length) {
        return res.status(502).json({
            error: 'Could not load trade data. ' + errors.join(' | '),
            trades: []
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
