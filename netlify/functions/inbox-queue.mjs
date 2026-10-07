/* WRAPT INBOX AGENT — what Command reads and resolves (X-Dash-Key auth).
     GET  /.netlify/functions/inbox-queue                   → {queue, suggestions, contacts, recent}
     POST {action:'attach', qid, lead_id}                   → file a queued email on that card
     POST {action:'dismiss', qid}                           → drop it
     POST {action:'resolve', sid, applied:true|false}       → clear a status or contact suggestion (Command applies it itself)
     POST {action:'test', from, subject, text}              → run one synthetic email through the pipeline (returns the result; no 202 dance)
                                                              capped in size, counts against AGENT_DAILY_LLM_MAX, refused when it's used up */
import { authOk, json, useSite, getStoreSafe } from './lib/wrapt-agents.mjs';
import { budgetLeft, dailyMax } from './lib/claude.mjs';
import { normalizeMessage, processMessage, queueState, attachQueued, dismissQueued, resolveSuggestion } from './lib/inbox-core.mjs';

export default async (req, context) => {
  if (!authOk(req)) return json({ error: 'unauthorized' }, 401);
  useSite(context);
  const store = await getStoreSafe();
  if (req.method === 'GET') return json(await queueState(store));
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  let b = {}; try { b = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  try {
    switch (b.action) {
      case 'attach': return json(await attachQueued(store, String(b.qid || ''), String(b.lead_id || '')));
      case 'dismiss': return json(await dismissQueued(store, String(b.qid || '')));
      case 'resolve': return json(await resolveSuggestion(store, String(b.sid || ''), !!b.applied));
      case 'test': {
        if (!(await budgetLeft())) return json({ error: `Daily AI limit reached (${dailyMax()} calls, AGENT_DAILY_LLM_MAX) — try again tomorrow.` }, 429);
        const cap = (v, n) => String(v ?? '').slice(0, n);
        const msg = normalizeMessage({ provider: 'test', from: cap(b.from, 200), to: cap(b.to || 'paige@wraptvending.com', 200), subject: cap(b.subject, 300), text: cap(b.text, 6000), date: new Date().toISOString(), message_id: `<test-${Date.now()}@wrapt>` });
        return json(await processMessage(msg, { store }));
      }
      default: return json({ error: 'unknown action' }, 400);
    }
  } catch (e) { return json({ error: e.message }, 500); }
};
