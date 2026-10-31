import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSync } from '../netlify/functions/lib/haha-sync-core.mjs';
import { addDays, centralDay } from '../netlify/functions/lib/haha.mjs';
import { memoryStore, mockHaha, fixture, sale, noSleep, withEnv } from './helpers.mjs';

const ENV = { HAHA_ENV: 'test', HAHA_APPKEY: 'key-1', HAHA_APPSECRET: 'secret-1', HAHA_ALERT_TO: null };
const NOW = new Date('2026-10-28T15:00:00Z'); // 10am Central
const TODAY = centralDay(NOW), YDAY = addDays(TODAY, -1);
const http = h => ({ fetchImpl: h.fetchImpl, sleep: noSleep, limiter: { take: async () => {} } });

function fleet() {
  const d = fixture();
  d.sales = [
    sale({ id: 'A1', at: '2026-10-28T13:05:00Z' }),
    sale({ id: 'A2', at: '2026-10-28T14:10:00Z', items: [['p2', 'Red Bull 12oz', 2, '3.75']] }),
    sale({ id: 'A3', at: '2026-10-27T22:00:00Z', marketId: '440002' }),
    sale({ id: 'A4', at: '2026-10-28T04:30:00Z' }), // 11:30pm Central on the 27th
  ];
  return d;
}

test('full sync fills the store; a second run is a no-op with no duplicates', async () => withEnv(ENV, async () => {
  const store = memoryStore(), data = fleet(), h = mockHaha(data);
  const r1 = await runSync({ store, now: NOW, http: http(h) });
  assert.equal(r1.ok, true, r1.errors.join('; '));
  assert.deepEqual(r1.warnings, []);

  const machines = store.json('markets/latest').machines;
  assert.deepEqual(Object.keys(machines).sort(), ['440001', '440002']);
  assert.equal(machines['440001'].online, true);
  assert.equal(Object.keys(store.json('products/latest').products).length, 2);
  assert.equal(store.json('inventory/latest').machines['440001'].products.p2.stock, 0);
  assert.deepEqual(store.json('planograms/latest').machines['440001'].capacity, { p1: 12, p2: 8 });
  assert.deepEqual(Object.keys(store.json(`sales/${TODAY}`).sales).sort(), ['A1', 'A2']);
  assert.deepEqual(Object.keys(store.json(`sales/${YDAY}`).sales).sort(), ['A3', 'A4']); // filed by Central day
  assert.equal(store.json(`sales/${TODAY}`).sales.A2.gross, 823); // 7.50 + 9.75 % tax
  assert.equal(Object.keys(store.json('restocks/2026-10').records).length, 1);
  assert.ok(store.json('sync/state').lastOk);

  const salesWrites = () => store.writes.filter(k => k.startsWith('sales/') || k.startsWith('products/') || k.startsWith('inventory/') || k.startsWith('planograms/') || k.startsWith('restocks/')).length;
  const before = salesWrites();
  const r2 = await runSync({ store, now: new Date(NOW.getTime() + 15 * 60e3), http: http(h) });
  assert.equal(r2.ok, true);
  assert.equal(salesWrites(), before, 'second run rewrote data that had not changed');
  assert.equal(Object.keys(store.json(`sales/${TODAY}`).sales).length, 2);
  assert.equal(r2.results.sales.added, 0);
}));

test('works whether HAHA reads end_time as inclusive or exclusive', async () => withEnv(ENV, async () => {
  for (const endInclusive of [true, false]) {
    const store = memoryStore(), h = mockHaha(fleet(), { endInclusive });
    await runSync({ store, now: NOW, http: http(h) });
    assert.deepEqual(Object.keys(store.json(`sales/${TODAY}`).sales).sort(), ['A1', 'A2'], `endInclusive=${endInclusive}`);
  }
}));

test('a refund updates the same sale (upsert), no duplicate row', async () => withEnv(ENV, async () => {
  const store = memoryStore(), data = fleet(), h = mockHaha(data);
  await runSync({ store, now: NOW, http: http(h) });
  const i = data.sales.findIndex(s => s.saleId === 'A1');
  data.sales[i] = { ...data.sales[i], isRefund: true, status: 'REFUNDED' };
  const r = await runSync({ store, now: new Date(NOW.getTime() + 15 * 60e3), http: http(h) });
  assert.equal(r.results.sales.changed, 1);
  const day = store.json(`sales/${TODAY}`).sales;
  assert.equal(Object.keys(day).length, 2);
  assert.equal(day.A1.refund, true);
}));

test('network dies mid-run: earlier data survives, the failure is recorded', async () => withEnv(ENV, async () => {
  const store = memoryStore(), data = fleet();
  await runSync({ store, now: NOW, http: http(mockHaha(data)) });
  const goodInventory = store.json('inventory/latest');
  const goodSales = store.json(`sales/${TODAY}`);

  data.sales.push(sale({ id: 'A9', at: '2026-10-28T14:50:00Z' }));
  const broken = mockHaha(data, { fail: ({ path }) => (/inventory|sales/.test(path) ? new TypeError('fetch failed') : null) });
  const r = await runSync({ store, now: new Date(NOW.getTime() + 15 * 60e3), http: http(broken) });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /inventory: network/);
  assert.deepEqual(store.json('inventory/latest'), goodInventory);
  assert.deepEqual(store.json(`sales/${TODAY}`), goodSales);
  const state = store.json('sync/state');
  assert.equal(state.lastOk, NOW.toISOString()); // last good run unchanged
  assert.ok(state.resources.sales.error);
  assert.ok(state.resources.markets.ok_at > NOW.toISOString()); // the parts that worked moved on
}));

test('a failed read of a day file never rebuilds it from nothing', async () => withEnv(ENV, async () => {
  const store = memoryStore(), data = fleet();
  await runSync({ store, now: NOW, http: http(mockHaha(data)) });
  const good = store.json(`sales/${TODAY}`);
  store.failGet = new RegExp(`^sales/${TODAY}$`);
  const r = await runSync({ store, now: new Date(NOW.getTime() + 15 * 60e3), http: http(mockHaha(data)) });
  store.failGet = null;
  assert.equal(r.ok, false);
  assert.deepEqual(store.json(`sales/${TODAY}`), good);
}));

test('an empty machine list from HAHA keeps the previous one', async () => withEnv(ENV, async () => {
  const store = memoryStore(), data = fleet();
  await runSync({ store, now: NOW, http: http(mockHaha(data)) });
  const r = await runSync({ store, now: new Date(NOW.getTime() + 15 * 60e3), http: http(mockHaha({ ...data, markets: [] })) });
  assert.equal(Object.keys(store.json('markets/latest').machines).length, 2);
  assert.match(r.warnings.join(' '), /kept the previous list/);
}));

test('backfill pulls day by day and records progress', async () => withEnv(ENV, async () => {
  const store = memoryStore(), data = fleet(), h = mockHaha(data);
  data.sales.push(sale({ id: 'OLD1', at: '2026-09-02T18:00:00Z' }), sale({ id: 'OLD2', at: '2026-09-04T18:00:00Z' }));
  const r = await runSync({ store, now: NOW, mode: 'backfill', from: '2026-09-01', to: '2026-09-05', http: http(h) });
  assert.equal(r.ok, true);
  const b = store.json('sync/state').backfill;
  assert.equal(b.done, 5);
  assert.ok(b.finished);
  assert.ok(store.json('sales/2026-09-02').sales.OLD1);
  assert.ok(store.json('sales/2026-09-04').sales.OLD2);
  const salesCalls = h.calls.filter(c => c.path.endsWith('/sales'));
  assert.equal(salesCalls.length, 5);
  assert.deepEqual(salesCalls[0].query.start_time, '2026-09-01');
}));

test('a 90-day backfill stays under 80 sales requests in any minute', async () => withEnv(ENV, async () => {
  const { makeLimiter } = await import('../netlify/functions/lib/haha.mjs');
  let clock = 0;
  const limiter = makeLimiter({ now: () => clock });
  const sleep = async ms => { clock += ms; };
  const stamps = [];
  const h = mockHaha(fleet());
  const fetchImpl = async (u, init) => { if (String(u).includes('/sales')) stamps.push(clock); clock += 50; return h.fetchImpl(u, init); };
  const store = memoryStore();
  await runSync({ store, now: NOW, mode: 'backfill', from: '2026-07-01', to: '2026-09-28', http: { fetchImpl, sleep, limiter } });
  assert.equal(stamps.length, 90);
  for (const t of stamps) assert.ok(stamps.filter(x => x >= t && x < t + 60_000).length <= 80);
}));

test('overlapping regular runs: the second one steps aside', async () => withEnv(ENV, async () => {
  const store = memoryStore();
  await store.setJSON('sync/lock', { at: NOW.toISOString() });
  const r = await runSync({ store, now: new Date(NOW.getTime() + 60e3), http: http(mockHaha(fleet())) });
  assert.match(r.skipped, /running/);
}));

test('poke pulls only what webhooks marked dirty', async () => withEnv(ENV, async () => {
  const store = memoryStore(), h = mockHaha(fleet());
  await store.setJSON('webhook/dirty', { sales: NOW.toISOString() });
  const r = await runSync({ store, now: new Date(NOW.getTime() + 1000), mode: 'poke', http: http(h) });
  assert.equal(r.ok, true);
  const paths = new Set(h.calls.map(c => c.path.replace('/open/api/v1', '')));
  assert.ok(paths.has('/sales'));
  assert.ok(!paths.has('/markets') && !paths.has('/inventory/products'));
  // nothing new → nothing pulled
  const h2 = mockHaha(fleet());
  await runSync({ store, now: new Date(NOW.getTime() + 2000), mode: 'poke', http: http(h2) });
  assert.equal(h2.calls.filter(c => c.path.endsWith('/sales')).length, 0);
}));
