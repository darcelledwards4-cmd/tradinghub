module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');

    const key = process.env.QUIVER_API_KEY;
    if (!key) {
        return res.status(500).json({
            error: 'QUIVER_API_KEY not set. Add your free Quiver Quant API key to Vercel environment variables.',
            trades: []
        });
    }

    try {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 8000);

        const r = await fetch('https://api.quiverquant.com/beta/live/congresstrading', {
            headers: {
                'Authorization': `Token ${key}`,
                'Accept': 'application/json'
            },
            signal: controller.signal
        });

        if (!r.ok) {
            const body = await r.text();
            return res.status(502).json({
                error: `Quiver API error ${r.status}: ${body.slice(0, 200)}`,
                trades: []
            });
        }

        const raw = await r.json();
        if (!Array.isArray(raw)) {
            return res.status(502).json({ error: 'Unexpected response format', trades: [] });
        }

        // Filter last 90 days and normalize fields
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 90);

        const trades = raw
            .filter(t => {
                const ticker = (t.Ticker || t.ticker || '').trim();
                const date = t.Date || t.date || t.TransactionDate || '';
                return ticker && ticker !== '--' && ticker.length <= 6 && date && new Date(date) >= cutoff;
            })
            .slice(0, 60)
            .map(t => ({
                chamber: t.Chamber || t.chamber || 'Congress',
                member: t.Representative || t.Senator || t.representative || t.senator || 'Unknown',
                party: t.Party || t.party || '',
                ticker: (t.Ticker || t.ticker || '').toUpperCase().trim(),
                asset: (t.AssetDescription || t.asset_description || t.Company || '').slice(0, 80),
                type: t.Transaction || t.transaction || t.type || '',
                amount: t.Range || t.range || t.Amount || t.amount || '',
                trade_date: t.Date || t.date || t.TransactionDate || '',
                disclosure_date: t.ReportDate || t.report_date || t.DisclosureDate || '',
                district: t.State || t.state || t.District || ''
            }))
            .sort((a, b) => new Date(b.trade_date) - new Date(a.trade_date));

        return res.status(200).json({ trades, fetched_at: new Date().toISOString() });
    } catch (err) {
        return res.status(500).json({ error: err.message, trades: [] });
    }
};
