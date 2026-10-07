/* WRAPT INBOX AGENT — the webhook. Background function: replies 202 at once (what every
   inbound-email service wants), then files the email on the right card.
     POST /.netlify/functions/inbox?s=<INBOX_SECRET>
   Accepts Postmark, CloudMailin, Mailgun, SendGrid Inbound Parse, or generic JSON
   {from,to,subject,text,date,message_id,in_reply_to,references}. */
import { useSite, getStoreSafe } from './lib/wrapt-agents.mjs';
import { INBOX, readPayload, normalizeMessage, processMessage } from './lib/inbox-core.mjs';

export default async (req, context) => {
  if (req.method !== 'POST') return;
  const s = new URL(req.url).searchParams.get('s') || req.headers.get('x-inbox-secret') || '';
  if (!INBOX.secret || s !== INBOX.secret) { console.warn('[wrapt-inbox] rejected: bad or missing secret'); return; }
  useSite(context);
  try {
    const { payload, contentType } = await readPayload(req);
    const msg = normalizeMessage(payload, { contentType });
    const store = await getStoreSafe();
    const r = await processMessage(msg, { store });
    console.log(`[wrapt-inbox] ${msg.provider} ${r.action}${r.lead_id ? ' → ' + r.lead_id + ' (' + r.score + ', ' + r.why + ')' : ''}${r.why && !r.lead_id ? ' — ' + r.why : ''} :: ${msg.from.email} "${(msg.subject || '').slice(0, 60)}"`);
  } catch (e) {
    console.error('[wrapt-inbox] failed:', e.message);
  }
};

export const config = { background: true };
