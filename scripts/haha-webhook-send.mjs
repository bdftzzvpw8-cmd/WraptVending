#!/usr/bin/env node
// Sign a sample HAHA webhook and POST it — for testing haha-webhook under `netlify dev`.
//   HAHA_WEBHOOK_SECRET=... node scripts/haha-webhook-send.mjs [--url URL] [--type mmsSales] [--replay] [--bad-signature] [--stale] [--file payload.json]
// Default URL: http://localhost:8888/.netlify/functions/haha-webhook
// Expect: 200 {ok, resource}; --replay → second reply {duplicate:true}; --bad-signature / --stale → 401.
// The built-in sample is only an envelope (vdiHeader + an empty body); pass --file with a real payload from HAHA's docs to test more.
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const flag = name => args.includes(name);

const url = opt('--url', 'http://localhost:8888/.netlify/functions/haha-webhook');
const secret = process.env.HAHA_WEBHOOK_SECRET;
if (!secret) { console.error('Set HAHA_WEBHOOK_SECRET (the same value the site uses).'); process.exit(1); }

const type = opt('--type', 'mmsSales');
const file = opt('--file');
const body = file ? readFileSync(file, 'utf8') : JSON.stringify({
  vdiHeader: { vdiType: type, requestId: randomUUID(), correlationId: randomUUID(), transactionDtm: new Date().toISOString() },
  [type]: {},
});
const ts = String(Math.floor(Date.now() / 1000) - (flag('--stale') ? 600 : 0));
const sig = flag('--bad-signature') ? '0'.repeat(64) : createHmac('sha256', secret).update(body).digest('hex');

async function send(label) {
  const r = await fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-webhook-signature': sig, 'x-webhook-timestamp': ts } });
  console.log(`${label}: HTTP ${r.status} ${await r.text()}`);
}
await send('send');
if (flag('--replay')) await send('replay');
