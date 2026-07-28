module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const key = process.env.CLAUDE_API_KEY;
    if (!key) return res.status(500).json({ error: 'CLAUDE_API_KEY not set in Vercel environment variables' });

    try {
        const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': key.trim(),
                'anthropic-version': '2023-06-01',
            },
            body,
        });

        const text = await response.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch {
            console.error('[claude] Non-JSON response from Anthropic:', text.slice(0, 300));
            return res.status(502).json({ error: 'Anthropic returned non-JSON response', raw: text.slice(0, 300) });
        }

        return res.status(response.status).json(data);
    } catch (err) {
        console.error('[claude] handler error:', err.message);
        return res.status(500).json({ error: err.message });
    }
};
