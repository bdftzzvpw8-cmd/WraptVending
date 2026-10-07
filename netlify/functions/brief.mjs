/* WRAPT AGENTS — the brief endpoint Command talks to.
     GET  /.netlify/functions/brief           → latest stored brief (or {empty:true})
     GET  /.netlify/functions/brief?text=1    → plain-text version (quick read on the phone)
     POST /.netlify/functions/brief           → kick the background worker; replies {queued:true, since}
                                                Command then polls GET until generated_at moves past `since`.
   Auth: same X-Dash-Key header Command already sends (refused when DASH_KEY is unset). */
import { getLatestBrief, kickWorker, briefText, authOk, json, useSite } from './lib/wrapt-agents.mjs';

export default async (req, context) => {
  if (!authOk(req)) return json({ error: 'unauthorized' }, 401);
  useSite(context);
  const url = new URL(req.url);
  if (req.method === 'POST') {
    const latest = await getLatestBrief();
    try { await kickWorker('manual'); } catch (e) { return json({ error: e.message }, 502); }
    return json({ queued: true, since: latest?.generated_at || null });
  }
  if (req.method !== 'GET') return json({ error: 'method' }, 405);
  const brief = await getLatestBrief();
  if (!brief) return json({ empty: true, hint: 'No brief yet — POST to run the agents.' });
  if (url.searchParams.get('text')) return new Response(briefText(brief), { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  return json(brief);
};
