/* WRAPT INBOX AGENT — the webhook.
     POST /.netlify/functions/inbox?s=<INBOX_SECRET>
   Accepts Postmark, CloudMailin, Mailgun, SendGrid Inbound Parse, or generic JSON
   {from,to,subject,text,date,message_id,in_reply_to,references}.
   Synchronous gate: a wrong or missing secret gets a real 401 (so the Gmail sync stops and says so instead of
   advancing past mail that was never filed). A good request is handed to inbox-worker-background (background, 202 at once). */
import { useSite } from './lib/wrapt-agents.mjs';
import { INBOX } from './lib/inbox-core.mjs';
import { timingSafeEqual } from 'node:crypto';

const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

export default async (req, context) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  if (!INBOX.secret) return Response.json({ error: 'INBOX_SECRET is not set on the site' }, { status: 503 });
  const s = new URL(req.url).searchParams.get('s') || req.headers.get('x-inbox-secret') || '';
  if (!same(s, INBOX.secret)) { console.warn('[wrapt-inbox] rejected: bad or missing secret'); return Response.json({ error: 'bad inbox secret' }, { status: 401 }); }
  const site = useSite(context);
  const body = await req.arrayBuffer();
  try {
    const r = await fetch(`${site}/.netlify/functions/inbox-worker-background`, {
      method: 'POST', body,
      headers: { 'content-type': req.headers.get('content-type') || 'application/json', 'x-inbox-secret': INBOX.secret },
    });
    if (r.status !== 202 && !r.ok) throw new Error(`inbox-worker-background: HTTP ${r.status}`);
  } catch (e) {
    console.error('[wrapt-inbox] hand-off failed:', e.message);
    return Response.json({ error: 'could not queue the message, retry' }, { status: 502 }); // sender retries; nothing was marked seen
  }
  return Response.json({ accepted: true }, { status: 202 });
};
