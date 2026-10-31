/* HAHA sync worker (background function: up to 15 minutes, replies 202 at once).
     POST /.netlify/functions/haha-sync-background?mode=regular             the 15-minute pass (schedule, "Sync now")
     POST /.netlify/functions/haha-sync-background?mode=poke                pull what webhooks marked dirty
     POST /.netlify/functions/haha-sync-background?mode=backfill&from=&to=  sales, day by day (haha-backfill starts it)
   Auth: X-Dash-Key, same as every other function. Results land in sync/state (read via haha-api?view=state). */
import { dashKeyDenied } from './lib/dash-key.mjs';
import { runSync } from './lib/haha-sync-core.mjs';
import { isDay } from './lib/haha.mjs';

export default async (req) => {
  const denied = dashKeyDenied(req);
  if (denied) return denied;
  const u = new URL(req.url);
  const mode = u.searchParams.get('mode') || 'regular';
  if (!['regular', 'poke', 'backfill', 'light'].includes(mode)) { console.warn(`[haha-sync] unknown mode ${mode}`); return; }
  const from = u.searchParams.get('from'), to = u.searchParams.get('to');
  if (mode === 'backfill' && !(isDay(from) && isDay(to) && from <= to)) { console.warn('[haha-sync] backfill needs from <= to (YYYY-MM-DD)'); return; }
  const r = await runSync({ mode, from, to });
  if (r.skipped) console.log(`[haha-sync] ${mode}: ${r.skipped}`);
  else console.log(`[haha-sync] ${mode} ${r.ok ? 'ok' : `errors: ${r.errors.join(' | ')}`} — ${r.ms}ms${r.warnings.length ? ` — ${r.warnings.length} warning(s)` : ''}`);
};
