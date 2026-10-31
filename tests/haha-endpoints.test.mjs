import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setStoreForTests, signBody } from '../netlify/functions/lib/haha.mjs';
import webhook from '../netlify/functions/haha-webhook.mjs';
import api from '../netlify/functions/haha-api.mjs';
import { memoryStore, sale } from './helpers.mjs';
import { normalizeSale, makeWarn } from '../netlify/functions/lib/haha-data.mjs';

const SECRET = 'whsec-test';
let store, kicks;
const realFetch = globalThis.fetch;
process.env.HAHA_WEBHOOK_SECRET = SECRET;
process.env.DASH_KEY = 'dash-test';
process.env.URL = 'http://localhost:8888';

beforeEach(() => {
  store = memoryStore();
  setStoreForTests(store);
  kicks = [];
  globalThis.fetch = async (u) => { kicks.push(String(u)); return new Response(null, { status: 202 }); };
});
after(() => { setStoreForTests(null); globalThis.fetch = realFetch; });

const signed = (body, { ts = Math.floor(Date.now() / 1000), secret = SECRET, sig } = {}) => {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request('http://localhost/.netlify/functions/haha-webhook', {
    method: 'POST', body: raw,
    headers: { 'content-type': 'application/json', 'x-webhook-timestamp': String(ts), 'x-webhook-signature': sig ?? signBody(raw, secret) },
  });
};
const order = { vdiHeader: { vdiType: 'mmsSales', requestId: 'req-001', correlationId: 'c-1', transactionDtm: '2026-10-28T15:00:00Z' }, mmsSales: { note: 'payload not parsed here' } };

test('webhook: a signed sample is accepted, marks sales dirty and kicks the worker', async () => {
  const r = await webhook(signed(order), {});
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, resource: 'sales' });
  assert.ok(store.json('webhook/dirty').sales);
  assert.equal(store.json('webhook/log').events[0].requestId, 'req-001');
  assert.ok(store.json('webhook/sample/mmsSales').body.vdiHeader);
  assert.equal(kicks.length, 1);
  assert.match(kicks[0], /haha-sync-background\?mode=poke$/);
});

test('webhook: a replay is acknowledged and ignored', async () => {
  await webhook(signed(order), {});
  const r = await webhook(signed(order), {});
  assert.equal(r.status, 200);
  assert.equal((await r.json()).duplicate, true);
  assert.equal(kicks.length, 1);
  assert.equal(store.json('webhook/log').events.length, 1);
});

test('webhook: bad signature, tampered body, stale timestamp, missing headers → 401', async () => {
  assert.equal((await webhook(signed(order, { secret: 'wrong' }), {})).status, 401);
  const raw = JSON.stringify(order);
  const tampered = new Request('http://localhost/x', { method: 'POST', body: raw.replace('req-001', 'req-002'), headers: { 'x-webhook-timestamp': String(Math.floor(Date.now() / 1000)), 'x-webhook-signature': signBody(raw, SECRET) } });
  assert.equal((await webhook(tampered, {})).status, 401);
  assert.equal((await webhook(signed(order, { ts: Math.floor(Date.now() / 1000) - 600 }), {})).status, 401);
  assert.equal((await webhook(new Request('http://localhost/x', { method: 'POST', body: raw }), {})).status, 401);
  assert.equal(kicks.length, 0);
  assert.equal(store.json('webhook/log'), null);
});

test('webhook: an unmapped vdiType is stored but pulls nothing', async () => {
  const r = await webhook(signed({ vdiHeader: { vdiType: 'mmsSomethingNew', requestId: 'x' } }), {});
  assert.deepEqual(await r.json(), { ok: true, resource: null });
  assert.equal(kicks.length, 0);
});

const call = (path, { key = 'dash-test', method = 'GET', body } = {}) => api(new Request(`http://localhost/.netlify/functions/haha-api${path}`, {
  method, headers: { ...(key ? { 'x-dash-key': key } : {}), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
}), {});

test('api: unusable without the dashboard key', async () => {
  assert.equal((await call('?view=summary', { key: '' })).status, 401);
  assert.equal((await call('?view=summary', { key: 'nope' })).status, 401);
  assert.equal((await call('?view=summary')).status, 200);
});

test('api: config round trip, validation, and conflict', async () => {
  const c0 = await (await call('?view=config')).json();
  assert.equal(c0.seeded, true);
  assert.equal(c0.hosts[0].hostId, 'firestone');
  assert.equal((await call('?view=config', { method: 'POST', body: { hosts: [{ hostId: 'x', name: 'X', rate: '7' }] } })).status, 400);
  const saved = await (await call('?view=config', { method: 'POST', body: { base: c0.updated, hosts: [{ hostId: 'firestone', name: 'Firestone', marketIds: ['440001'], rate: '0.10' }], settings: { cardPercent: '2.9', cardFixed: '0.30', hahaMonthlyDefault: '5.00' } } })).json();
  assert.equal(saved.ok, true);
  assert.equal(saved.seeded, false);
  const stale = await call('?view=config', { method: 'POST', body: { base: '2020-01-01T00:00:00.000Z', settings: {} } });
  assert.equal(stale.status, 409);
  // a bad fee rejects the whole save: the hosts in the same request are not written
  const half = await call('?view=config', { method: 'POST', body: { hosts: [{ hostId: 'other', name: 'Other' }], settings: { cardFixed: 'abc' } } });
  assert.equal(half.status, 400);
  assert.equal((await (await call('?view=config')).json()).hosts[0].hostId, 'firestone');
});

test('api: statement and orders read what the sync stored', async () => {
  await call('?view=config', { method: 'POST', body: { hosts: [{ hostId: 'firestone', name: 'Firestone', marketIds: ['440001'], rate: '0.10' }], settings: { cardPercent: '2.9', cardFixed: '0.30', hahaMonthlyDefault: '5.00' } } });
  const s = normalizeSale(sale({ id: 'Z1', at: '2026-10-03T15:00:00Z', items: [['p1', 'Coke', 4, '2.50']] }), makeWarn());
  await store.setJSON(`sales/${s.day}`, { day: s.day, sales: { Z1: s } });
  const st = await (await call('?view=statement&host=firestone&month=2026-10')).json();
  assert.equal(st.lines[0].cents, 1098);
  assert.equal(st.tx, 1);
  const o = await (await call(`?view=orders&day=${s.day}`)).json();
  assert.equal(o.orders[0].id, 'Z1');
  assert.equal((await call('?view=statement&host=nobody&month=2026-10')).status, 404);
  assert.equal((await call('?view=sales&from=2026-01-01&to=2026-10-01')).status, 400); // > 93 days
});
