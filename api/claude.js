export const config = { runtime: 'edge' };

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

export default async function handler(req) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...CORS, 'Content-Type': 'application/json' } });

    const key = process.env.CLAUDE_API_KEY;
    if (!key) return new Response(JSON.stringify({ error: 'CLAUDE_API_KEY not set in Vercel environment variables' }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });

    try {
        const body = await req.json();
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': key.trim(),
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify(body),
        });

        const text = await response.text();
        return new Response(text, {
            status: response.status,
            headers: { ...CORS, 'Content-Type': 'application/json' },
        });
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
}
