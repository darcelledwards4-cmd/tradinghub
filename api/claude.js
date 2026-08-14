// Node.js serverless function (not Edge) so maxDuration in vercel.json applies.
// Edge functions hard-cap at 30s regardless of config — too short for large Claude responses.

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

export default async function handler(req, res) {
    Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST')
        return res.status(405).json({ error: 'Method not allowed' });

    const key = process.env.CLAUDE_API_KEY;
    if (!key)
        return res.status(500).json({ error: 'CLAUDE_API_KEY not set in Vercel environment variables' });

    try {
        // Vercel auto-parses JSON bodies in Node.js functions, but guard against raw string/Buffer
        let body = req.body;
        if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e){} }
        const upstream = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': key.trim(),
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify(body),
        });

        const text = await upstream.text();
        res.status(upstream.status).setHeader('Content-Type', 'application/json').send(text);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}
