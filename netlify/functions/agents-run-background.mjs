/* WRAPT AGENTS — the worker. Background function (15-minute limit, replies 202 at once).
   Runs the pipeline + deal-watch agents and stores the brief. Kicked by agents-daily (schedule)
   and by brief.mjs (Command's "Run now"). Auth: same X-Dash-Key header Command sends. */
import { runAgents, authOk, useSite } from './lib/wrapt-agents.mjs';

export default async (req, context) => {
  if (!authOk(req)) { console.warn('[wrapt-agents] worker: unauthorized kick ignored'); return; }
  useSite(context);
  const trigger = new URL(req.url).searchParams.get('trigger') || 'manual';
  const b = await runAgents({ trigger });
  console.log(`[wrapt-agents] ${b.day} (${trigger}) — ${b.summary} — drafts:${b.drafts_source} — ${b.ms}ms${b.errors.length ? ' — notes: ' + b.errors.join(' | ') : ''}`);
};

export const config = { background: true };
