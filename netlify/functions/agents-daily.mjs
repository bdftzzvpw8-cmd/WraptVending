/* WRAPT AGENTS — the morning schedule.
   Kicks the background worker (agents-run) so the 30-second scheduled-function limit never matters;
   if the kick itself fails it runs the agents inline as a fallback.
   Netlify cron is UTC: "0 11 * * *" = 6:00am CDT / 5:00am CST.
   Scheduled functions can't be hit by URL — use Command's "Run now" or the Netlify UI's Run now button. */
import { runAgents, kickWorker, useSite } from './lib/wrapt-agents.mjs';

export default async (req, context) => {
  useSite(context);
  try {
    const status = await kickWorker('scheduled');
    console.log(`[wrapt-agents] schedule → worker kicked (HTTP ${status})`);
  } catch (e) {
    console.warn(`[wrapt-agents] worker kick failed (${e.message}) — running inline`);
    const b = await runAgents({ trigger: 'scheduled' });
    console.log(`[wrapt-agents] ${b.day} — ${b.summary} — drafts:${b.drafts_source} — ${b.ms}ms${b.errors.length ? ' — notes: ' + b.errors.join(' | ') : ''}`);
  }
};

export const config = { schedule: '0 11 * * *' };
