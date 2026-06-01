/**
 * /api/supabase-config
 *
 * Returns the public Supabase project URL and anon key from Vercel env vars.
 * The anon key is safe to expose — it only grants what RLS policies allow.
 *
 * Required Vercel env vars:
 *   SUPABASE_URL      e.g. https://xxxx.supabase.co
 *   SUPABASE_ANON_KEY e.g. eyJhbGci...
 */
module.exports = function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const url     = process.env.SUPABASE_URL     || '';
    const anonKey = process.env.SUPABASE_ANON_KEY || '';
    if (!url || !anonKey) {
        return res.status(200).json({ configured: false, url: '', anonKey: '' });
    }
    return res.status(200).json({ configured: true, url, anonKey });
};
