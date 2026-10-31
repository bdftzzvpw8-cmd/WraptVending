/* HAHA webhooks — the fast path; the 15-minute sync stays the source of truth.
     POST /.netlify/functions/haha-webhook   (HAHA calls this; registered by HAHA support, api_version v2)
   1. Verify X-Webhook-Signature = hex(HMAC-SHA256(HAHA_WEBHOOK_SECRET, raw body bytes)) in constant time,
      X-Webhook-Timestamp within 5 minutes → otherwise 401. The raw bytes are verified, never re-serialised JSON.
   2. Dedupe on vdiHeader.requestId + a hash of the body (HAHA retries) → a repeat gets 200 { duplicate: true }.
   3. Mark the touched resource dirty (vdiType → resource) and kick the worker to re-pull it from the REST API.
   Payload bodies are not parsed into sales/stock here: their field shapes differ from the REST responses and
   haven't been checked against HAHA's payload pages yet. The latest body of each vdiType is kept under
   webhook/sample/{vdiType} so the mapping can be written from real data. Replies within ~1 s. */
import { createHash } from 'node:crypto';
import { hahaStore, readJSON, verifyWebhook, centralDay, addDays } from './lib/haha.mjs';
import { VDI_RESOURCE, kickWorker, siteOf } from './lib/haha-sync-core.mjs';

const MAX_BYTES = 1024 * 1024;
const reply = (obj, status = 200) => Response.json(obj, { status, headers: { 'cache-control': 'no-store' } });

export default async (req, context) => {
  if (req.method !== 'POST') return reply({ error: 'method' }, 405);
  const raw = Buffer.from(await req.arrayBuffer());
  if (raw.length > MAX_BYTES) return reply({ error: 'too large' }, 413);
  const v = verifyWebhook({
    raw, secret: process.env.HAHA_WEBHOOK_SECRET,
    signature: req.headers.get('x-webhook-signature'), timestamp: req.headers.get('x-webhook-timestamp'),
  });
  if (!v.ok) { console.warn(`[haha-webhook] rejected: ${v.error}`); return reply({ error: v.error }, v.status); }

  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return reply({ error: 'bad json' }, 400); }
  const hdr = body?.vdiHeader || {};
  const vdiType = String(hdr.vdiType || '').slice(0, 60), requestId = String(hdr.requestId || '').slice(0, 200);
  const key = createHash('sha256').update(requestId).update('\0').update(raw).digest('hex').slice(0, 40);
  const now = new Date(), nowISO = now.toISOString(), today = centralDay(now);

  let store;
  try { store = await hahaStore(); } catch (e) { console.error('[haha-webhook] store', e.message); return reply({ error: 'storage unavailable' }, 503); }
  try {
    const seen = await Promise.all([today, addDays(today, -1)].map(d => store.get(`webhook/seen/${d}/${key}`)));
    if (seen.some(Boolean)) return reply({ ok: true, duplicate: true });
    await store.setJSON(`webhook/seen/${today}/${key}`, { at: nowISO, vdiType, requestId });
  } catch (e) { console.error('[haha-webhook] dedupe', e.message); return reply({ error: 'storage unavailable' }, 503); } // HAHA retries

  const resource = VDI_RESOURCE[vdiType] || null;
  const tasks = [
    readJSON(store, 'webhook/log', { events: [] }).then(log => store.setJSON('webhook/log', { events: [...log.events, { at: nowISO, vdiType, requestId, resource }].slice(-200) })),
    vdiType ? store.setJSON(`webhook/sample/${vdiType.replace(/[^\w.-]/g, '_')}`, { at: nowISO, body }) : null,
    resource ? readJSON(store, 'webhook/dirty', {}).then(d => store.setJSON('webhook/dirty', { ...d, [resource]: nowISO })) : null,
  ];
  const done = await Promise.allSettled(tasks);
  done.forEach(r => { if (r.status === 'rejected') console.warn('[haha-webhook] write', r.reason?.message); });

  if (resource) {
    try { await kickWorker(siteOf(context), { mode: 'poke' }); } catch (e) { console.warn(`[haha-webhook] kick failed (${e.message}) — the 15-minute sync will pick it up`); }
  } else console.log(`[haha-webhook] ${vdiType || 'no vdiType'}: stored, no resource mapped`);
  return reply({ ok: true, resource });
};
