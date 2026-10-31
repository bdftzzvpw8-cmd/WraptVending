/* HAHA backfill — pull past sales day by day, under the rate limit.
     POST /.netlify/functions/haha-backfill  { from: "YYYY-MM-DD", to?: "YYYY-MM-DD" }  → { queued, from, to, days }
     GET  /.netlify/functions/haha-backfill                                            → progress { from, to, done, total, failed, finished }
   `to` defaults to yesterday (Central). Up to 400 days per run. Auth: X-Dash-Key. */
import { dashKeyDenied } from './lib/dash-key.mjs';
import { hahaStore, readJSON, isDay, centralDay, addDays, dayRange } from './lib/haha.mjs';
import { kickWorker, siteOf, STATE_KEY } from './lib/haha-sync-core.mjs';
import { json } from './lib/wrapt-agents.mjs';

export default async (req, context) => {
  const denied = dashKeyDenied(req);
  if (denied) return denied;
  if (req.method === 'GET') {
    const state = await readJSON(await hahaStore(), STATE_KEY).catch(() => null);
    return json(state?.backfill || { idle: true });
  }
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  const today = centralDay(), from = String(body?.from || ''), to = String(body?.to || addDays(today, -1));
  if (!isDay(from) || !isDay(to)) return json({ error: 'from and to must be YYYY-MM-DD' }, 400);
  if (from > to) return json({ error: 'from is after to' }, 400);
  if (to > today) return json({ error: 'to is in the future' }, 400);
  const days = dayRange(from, to).length;
  if (days > 400) return json({ error: 'at most 400 days per backfill' }, 400);
  if (!process.env.HAHA_APPKEY || !process.env.HAHA_APPSECRET) return json({ error: 'HAHA_APPKEY / HAHA_APPSECRET are not set' }, 503);
  try { await kickWorker(siteOf(context), { mode: 'backfill', from, to }); } catch (e) { return json({ error: e.message }, 502); }
  return json({ queued: true, from, to, days });
};
