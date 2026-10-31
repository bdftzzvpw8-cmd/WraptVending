/* HAHA sync — the 15-minute schedule.
   Kicks the background worker (haha-sync-background) so the 30-second scheduled-function limit never matters;
   if the kick fails it runs a light sync inline (machines + today's sales).
   Does nothing until HAHA_APPKEY is set, so the schedule stays quiet before Open Platform access exists.
   Scheduled functions can't be hit by URL — use "Sync now" on /machines.html or the Netlify UI's Run now. */
import { runSync, kickWorker, siteOf } from './lib/haha-sync-core.mjs';

export default async (req, context) => {
  if (!process.env.HAHA_APPKEY || !process.env.HAHA_APPSECRET) { console.log('[haha-sync] HAHA_APPKEY / HAHA_APPSECRET not set — skipping'); return; }
  try {
    const status = await kickWorker(siteOf(context), { mode: 'regular' });
    console.log(`[haha-sync] worker kicked (HTTP ${status})`);
  } catch (e) {
    console.warn(`[haha-sync] worker kick failed (${e.message}) — running a light sync inline`);
    const r = await runSync({ mode: 'light' });
    console.log(`[haha-sync] light ${r.skipped || (r.ok ? 'ok' : r.errors.join(' | '))} ${r.ms ?? 0}ms`);
  }
};

export const config = { schedule: '*/15 * * * *' };
