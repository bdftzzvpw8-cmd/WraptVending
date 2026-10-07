/* WRAPT INBOX AGENT — the worker. Background function: replies 202 at once, then files the email on the
   right card. Called only by inbox.mjs (which has already checked the secret); it checks again so it can't
   be used directly. */
import { useSite, getStoreSafe } from './lib/wrapt-agents.mjs';
import { INBOX, readPayload, normalizeMessage, processMessage } from './lib/inbox-core.mjs';
import { timingSafeEqual } from 'node:crypto';

const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

export default async (req, context) => {
  if (req.method !== 'POST') return;
  if (!INBOX.secret || !same(req.headers.get('x-inbox-secret') || '', INBOX.secret)) { console.warn('[wrapt-inbox] worker: rejected'); return; }
  useSite(context);
  try {
    const { payload, contentType } = await readPayload(req);
    const msg = normalizeMessage(payload, { contentType });
    const store = await getStoreSafe();
    const r = await processMessage(msg, { store });
    console.log(`[wrapt-inbox] ${msg.provider} ${r.action}${r.lead_id ? ' → ' + r.lead_id + ' (' + r.score + ', ' + r.why + ')' : ''}${r.why && !r.lead_id ? ' — ' + r.why : ''} :: ${msg.from.email} "${(msg.subject || '').slice(0, 60)}"`);
  } catch (e) {
    console.error('[wrapt-inbox] failed (left unmarked, a re-send will retry):', e.message);
  }
};

export const config = { background: true };
