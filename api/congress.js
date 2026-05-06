module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');

    try {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 90); // last 90 days

        const [houseRes, senateRes] = await Promise.all([
            fetch('https://house-stock-watcher-data.s3-us-west-2.amazonaws.com/data/all_transactions.json'),
            fetch('https://senate-stock-watcher-data.s3-us-west-2.amazonaws.com/aggregate/all_transactions.json')
        ]);

        const [houseRaw, senateRaw] = await Promise.all([
            houseRes.json(),
            senateRes.json()
        ]);

        const houseTrades = (Array.isArray(houseRaw) ? houseRaw : [])
            .filter(t =>
                t.ticker && t.ticker !== '--' && t.ticker !== 'N/A' &&
                t.transaction_date && new Date(t.transaction_date) >= cutoff
            )
            .map(t => ({
                chamber: 'House',
                member: t.representative || 'Unknown',
                party: t.party || '',
                ticker: (t.ticker || '').toUpperCase(),
                asset: t.asset_description || '',
                type: t.type || '',
                amount: t.amount || '',
                trade_date: t.transaction_date,
                disclosure_date: t.disclosure_date || '',
                district: t.district || ''
            }));

        const senateTrades = (Array.isArray(senateRaw) ? senateRaw : [])
            .filter(t =>
                t.ticker && t.ticker !== '--' && t.ticker !== 'N/A' &&
                t.transaction_date && new Date(t.transaction_date) >= cutoff
            )
            .map(t => ({
                chamber: 'Senate',
                member: t.senator || 'Unknown',
                party: t.party || '',
                ticker: (t.ticker || '').toUpperCase(),
                asset: t.asset_description || t.asset_name || '',
                type: t.type || '',
                amount: t.amount || '',
                trade_date: t.transaction_date,
                disclosure_date: t.disclosure_date || '',
                district: t.state || ''
            }));

        const combined = [...houseTrades, ...senateTrades]
            .sort((a, b) => new Date(b.trade_date) - new Date(a.trade_date))
            .slice(0, 60);

        return res.status(200).json({ trades: combined, fetched_at: new Date().toISOString() });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};
