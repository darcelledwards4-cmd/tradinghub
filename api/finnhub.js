// Vercel serverless function — proxies Finnhub API calls
// Your Finnhub key lives here on Vercel's servers, never in the browser
export default async function handler(req, res) {
    const { endpoint, ...params } = req.query;
    if (!endpoint) {
        return res.status(400).json({ error: 'endpoint query param required' });
    }
    if (!process.env.FINNHUB_API_KEY) {
        return res.status(500).json({ error: 'FINNHUB_API_KEY not set in Vercel environment variables' });
    }
    try {
        const qs = new URLSearchParams({ ...params, token: process.env.FINNHUB_API_KEY }).toString();
        const response = await fetch(`https://finnhub.io/api/v1/${endpoint}?${qs}`);
        const data = await response.json();
        return res.status(response.status).json(data);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}
