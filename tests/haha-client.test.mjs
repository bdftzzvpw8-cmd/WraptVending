import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  money, fmt, decimalToScaled, mulRate, hahaFetch, paginate, fetchAll, getToken, makeLimiter, backoffMs,
  signBody, verifyWebhook, addDays, dayRange, monthDays, centralDay,
} from '../netlify/functions/lib/haha.mjs';
import { memoryStore, mockHaha, fixture, noSleep, withEnv } from './helpers.mjs';

const ENV = { HAHA_ENV: 'test', HAHA_APPKEY: 'key-1', HAHA_APPSECRET: 'secret-1' };
const freeLimiter = { take: async () => {} };

test('money: decimal strings to integer cents, no floats', () => {
  assert.equal(money('12.5'), 1250);
  assert.equal(money('0.10'), 10);
  assert.equal(money('-3.10'), -310);
  assert.equal(money('1,234.56'), 123456);
  assert.equal(money('0.125'), 13);
  assert.equal(money('-0.125'), -13);
  assert.equal(money('0.124'), 12);
  assert.equal(money(''), 0);
  assert.equal(money(null), 0);
  assert.equal(money(2.5), 250);
  assert.equal(money('.99'), 99);
  assert.equal(money('7'), 700);
  assert.equal(money('0.1') + money('0.2'), 30); // the float version is 0.30000000000000004
  assert.throws(() => money('abc'));
  assert.throws(() => money('1.2.3'));
});

test('fmt and rates', () => {
  assert.equal(fmt(123456), '$1,234.56');
  assert.equal(fmt(-150), '-$1.50');
  assert.equal(fmt(5), '$0.05');
  assert.equal(decimalToScaled('0.10'), 100000);
  assert.equal(decimalToScaled('2.9'), 2900000);
  assert.throws(() => decimalToScaled('0.1234567'));
  assert.equal(mulRate(10005, decimalToScaled('0.10')), 1001); // 1000.5 → half away from zero
  assert.equal(mulRate(-10005, decimalToScaled('0.10')), -1001);
  assert.equal(mulRate(10000, decimalToScaled('2.9'), 8), 290); // 2.9 % of $100
});

test('Central calendar helpers', () => {
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.deepEqual(dayRange('2026-10-30', '2026-11-02'), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  assert.equal(monthDays('2028-02').length, 29);
  assert.equal(centralDay('2026-11-01T04:30:00Z'), '2026-10-31'); // 11:30pm CDT the night before
});

test('paginate follows next_cursor and stops when there is none', async () => withEnv(ENV, async () => {
  const data = fixture();
  data.products = Array.from({ length: 250 }, (_, i) => ({ productId: `p${i}`, productName: `P${i}` }));
  const h = mockHaha(data);
  const all = await fetchAll('/products', {}, { store: memoryStore(), fetchImpl: h.fetchImpl, limiter: freeLimiter, sleep: noSleep });
  assert.equal(all.length, 250);
  const pages = h.calls.filter(c => c.path.endsWith('/products'));
  assert.equal(pages.length, 3);
  assert.equal(pages[1].query.cursor, 'c100');
  assert.equal(pages[2].query.cursor, 'c200');
}));

test('paginate walks page numbers when the endpoint gives no cursor', async () => withEnv(ENV, async () => {
  const data = fixture();
  data.products = Array.from({ length: 200 }, (_, i) => ({ productId: `p${i}` }));
  const h = mockHaha(data, { pageMode: true });
  let n = 0;
  for await (const _ of paginate('/products', {}, { store: memoryStore(), fetchImpl: h.fetchImpl, limiter: freeLimiter, sleep: noSleep })) n++;
  assert.equal(n, 200);
  assert.equal(h.calls.filter(c => c.path.endsWith('/products')).length, 2); // stops at total, no empty third page
}));

test('token: cached, reused, refreshed inside 2 days, refreshed once on a 401', async () => withEnv(ENV, async () => {
  const store = memoryStore(), h = mockHaha(fixture());
  const t1 = await getToken({ store, fetchImpl: h.fetchImpl });
  const t2 = await getToken({ store, fetchImpl: h.fetchImpl });
  assert.equal(t1, t2);
  assert.equal(h.counters.token, 1);
  assert.equal(store.json('auth/token').env, 'test');

  // 1 day left → refresh
  const rec = store.json('auth/token');
  await store.setJSON('auth/token', { ...rec, expires_at: Math.floor(Date.now() / 1000) + 86400 });
  const t3 = await getToken({ store, fetchImpl: h.fetchImpl });
  assert.notEqual(t3, t1);
  assert.equal(h.counters.token, 2);

  // the server revokes the cached token → one refresh, the call succeeds
  const h2 = mockHaha(fixture(), { revoked: t3 });
  const markets = await fetchAll('/markets', {}, { store, fetchImpl: h2.fetchImpl, limiter: freeLimiter, sleep: noSleep });
  assert.equal(markets.length, 2);
  assert.equal(h2.counters.token, 1);
}));

test('token: switching HAHA_ENV never reuses the other environment\'s token', async () => {
  const store = memoryStore(), h = mockHaha(fixture());
  await withEnv(ENV, () => getToken({ store, fetchImpl: h.fetchImpl }));
  await withEnv({ ...ENV, HAHA_ENV: 'prod' }, () => getToken({ store, fetchImpl: h.fetchImpl }));
  assert.equal(h.counters.token, 2);
  assert.equal(store.json('auth/token').env, 'prod');
});

test('429 and code -429 back off and retry; give up after 5 tries', async () => withEnv(ENV, async () => {
  let n = 0;
  const slept = [];
  const h = mockHaha(fixture(), {
    fail: ({ path }) => {
      if (!path.endsWith('/markets')) return null;
      n++;
      if (n === 1) return new Response('{}', { status: 429 });
      if (n === 2) return new Response(JSON.stringify({ code: -429, message: 'slow down' }), { status: 200 });
      return null;
    },
  });
  const store = memoryStore();
  const data = await hahaFetch('/markets', { store, fetchImpl: h.fetchImpl, limiter: freeLimiter, sleep: async ms => { slept.push(ms); }, rand: () => 0.5 });
  assert.equal(data.list.length, 2);
  assert.deepEqual(slept, [500, 1000]);

  const always = mockHaha(fixture(), { fail: ({ path }) => (path.endsWith('/markets') ? new Response('{}', { status: 429 }) : null) });
  const s2 = [];
  await assert.rejects(hahaFetch('/markets', { store, fetchImpl: always.fetchImpl, limiter: freeLimiter, sleep: async ms => { s2.push(ms); }, rand: () => 0.5 }), /rate limited/);
  assert.equal(s2.length, 4);
  assert.ok(s2.every(ms => ms <= 8000));
  assert.ok(backoffMs(10, () => 1) <= 8000 * 1.25);
}));

test('envelope errors throw with the HAHA code', async () => withEnv(ENV, async () => {
  const h = mockHaha(fixture(), { fail: ({ path }) => (path.endsWith('/markets') ? new Response(JSON.stringify({ code: 1003, message: 'param error' }), { status: 200 }) : null) });
  await assert.rejects(hahaFetch('/markets', { store: memoryStore(), fetchImpl: h.fetchImpl, limiter: freeLimiter, sleep: noSleep }), e => e.code === 1003);
}));

test('write calls are blocked until Phase 5; the batch read is allowed', async () => withEnv(ENV, async () => {
  const h = mockHaha(fixture());
  const opts = { store: memoryStore(), fetchImpl: h.fetchImpl, limiter: freeLimiter, sleep: noSleep };
  for (const [method, path] of [['POST', '/markets/440001/reboot'], ['POST', '/products/p1/price'], ['POST', '/inventory/adjust'], ['PUT', '/markets/440001'], ['DELETE', '/products/p1']]) {
    await assert.rejects(hahaFetch(path, { ...opts, method }), /blocked/);
  }
  assert.equal(h.calls.length, 0);
  await assert.rejects(hahaFetch('/products/batch', { ...opts, method: 'POST', body: { ids: ['p1'] } }), /HTTP 404/); // reached the server
}));

test('limiter keeps a type under its per-minute budget', async () => {
  let clock = 0;
  const lim = makeLimiter({ perType: 80, total: 400, now: () => clock });
  const sleep = async ms => { clock += ms; };
  const stamps = [];
  for (let i = 0; i < 200; i++) { await lim.take('sales', sleep); stamps.push(clock); }
  for (let i = 0; i < stamps.length; i++) {
    const inWindow = stamps.filter(t => t >= stamps[i] && t < stamps[i] + 60_000).length;
    assert.ok(inWindow <= 80, `window starting at ${stamps[i]} had ${inWindow}`);
  }
  assert.ok(clock >= 120_000); // 200 requests need at least two full windows
});

test('webhook HMAC: RFC 4231 vector, verify, reject, stale', () => {
  assert.equal(signBody('what do ya want for nothing?', 'Jefe'), '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  const raw = Buffer.from('{"vdiHeader":{"vdiType":"mmsSales","requestId":"r1"}}');
  const now = 1_790_000_000_000, ts = String(now / 1000);
  const sig = signBody(raw, 's3cret');
  assert.deepEqual(verifyWebhook({ raw, signature: sig, timestamp: ts, secret: 's3cret', now }), { ok: true });
  assert.deepEqual(verifyWebhook({ raw, signature: sig.toUpperCase(), timestamp: ts, secret: 's3cret', now }), { ok: true });
  assert.equal(verifyWebhook({ raw: Buffer.from(raw.toString().replace('r1', 'r2')), signature: sig, timestamp: ts, secret: 's3cret', now }).status, 401);
  assert.equal(verifyWebhook({ raw, signature: sig, timestamp: String(now / 1000 - 301), secret: 's3cret', now }).error, 'stale timestamp');
  assert.equal(verifyWebhook({ raw, signature: '', timestamp: ts, secret: 's3cret', now }).status, 401);
  assert.equal(verifyWebhook({ raw, signature: sig, timestamp: 'yesterday', secret: 's3cret', now }).status, 401);
  assert.equal(verifyWebhook({ raw, signature: sig, timestamp: ts, secret: '', now }).status, 503);
});
