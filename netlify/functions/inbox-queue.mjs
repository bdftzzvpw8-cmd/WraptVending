/* WRAPT INBOX AGENT — what Command reads and resolves (X-Dash-Key auth).
     GET  /.netlify/functions/inbox-queue                   → {queue, suggestions, recent}
     POST {action:'attach', qid, lead_id}                   → file a queued email on that card
     POST {action:'dismiss', qid}                           → drop it
     POST {action:'resolve', sid, applied:true|false}       → clear a status suggestion (Command applies the status itself)
     POST {action:'test', from, subject, text}              → run one synthetic email through the pipeline (returns the result; no 202 dance) */
import { authOk, json, useSite, getStoreSafe } from './lib/wrapt-agents.mjs';
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
        const msg = normalizeMessage({ provider: 'test', from: b.from, to: b.to || 'paige@wraptvending.com', subject: b.subject, text: b.text, date: new Date().toISOString(), message_id: b.message_id || `<test-${Date.now()}@wrapt>` });
        return json(await processMessage(msg, { store }));
      }
      default: return json({ error: 'unknown action' }, 400);
    }
  } catch (e) { return json({ error: e.message }, 500); }
};
