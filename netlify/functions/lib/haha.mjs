/* =====================================================================
   HAHA Open Platform client — shared by haha-sync, haha-webhook, haha-api
   ---------------------------------------------------------------------
   Read-only until Phase 5: hahaFetch refuses every method but GET, plus
   the one batch READ (POST /products/batch). Nothing here can change a
   machine (reboot, temperature, door, inventory, planogram, price).

   Env vars (Netlify → Site configuration → Environment variables, never the browser):
     HAHA_ENV             test | prod   (default test)
     HAHA_APPKEY          from the HAHA Merchant Portal
     HAHA_APPSECRET       from the HAHA Merchant Portal — never logged, never sent anywhere but /open/auth/token
     HAHA_WEBHOOK_SECRET  the shared secret given to HAHA support for webhooks

   Money: HAHA sends decimal strings. money() turns them into integer cents
   without ever going through a float; every sum in this codebase is cents.
   Days: Central calendar days (America/Chicago), same as the merchant account.
   ===================================================================== */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const TZ = 'America/Chicago';
export const BASES = { test: 'https://thor-openapi-test.hahavending.com', prod: 'https://thor-openapi.hahavending.com' };
export const PREFIX = '/open/api/v1';
export const STORE_NAME = 'haha';

export const hahaEnv = () => (String(process.env.HAHA_ENV || 'test').trim().toLowerCase() === 'prod' ? 'prod' : 'test');
export const baseUrl = () => BASES[hahaEnv()];

export class HahaError extends Error {
  constructor(message, { status, code, path } = {}) {
    super(message);
    this.name = 'HahaError';
    this.status = status;
    this.code = code;
    this.path = path;
  }
}

/* ---------- money: decimal strings → integer cents, never floats ---------- */
// "12.5" → 1250, "-3.10" → -310, "0.125" → 13 (half away from zero at the third decimal). Blank → 0.
export function money(v) {
  if (v == null || v === '') return 0;
  let s = typeof v === 'number' ? String(v) : String(v).trim();
  if (typeof v === 'number' && !Number.isFinite(v)) throw new TypeError(`not a money amount: ${v}`);
  if (/e/i.test(s)) s = Number(s).toFixed(6); // a JSON number like 1e-7
  const m = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(s.replace(/[$,\s]/g, ''));
  if (!m || (!m[2] && !m[3])) throw new TypeError(`not a money amount: ${JSON.stringify(v)}`);
  const frac = m[3] || '';
  let cents = Number(m[2] || '0') * 100 + Number((frac + '00').slice(0, 2));
  if (frac.length > 2 && Number(frac[2]) >= 5) cents += 1;
  return m[1] === '-' ? -cents : cents;
}

export function fmt(cents) {
  const n = Math.round(Number(cents) || 0), a = Math.abs(n);
  return `${n < 0 ? '-' : ''}$${Math.floor(a / 100).toLocaleString('en-US')}.${String(a % 100).padStart(2, '0')}`;
}

/* rates without floats: "0.10" → 100000 at 6 digits; mulRate(cents, scaled, 6) applies it, rounding half away from zero */
export function decimalToScaled(v, digits = 6) {
  const s = String(v ?? '').trim();
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (!m[1] && !m[2])) throw new TypeError(`not a decimal: ${JSON.stringify(v)}`);
  const frac = m[2] || '';
  if (frac.length > digits && /[1-9]/.test(frac.slice(digits))) throw new TypeError(`more than ${digits} decimals: ${s}`);
  return Number(m[1] || '0') * 10 ** digits + Number(frac.slice(0, digits).padEnd(digits, '0'));
}
export function mulRate(cents, scaled, digits = 6) {
  const den = 10n ** BigInt(digits);
  const p = BigInt(Math.round(cents)) * BigInt(scaled);
  const a = p < 0n ? -p : p;
  const r = (a * 2n + den) / (2n * den);
  return Number(p < 0n ? -r : r);
}

/* ---------- Central calendar ---------- */
export const centralDay = (d = new Date()) => new Date(d).toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
export const centralHour = (d = new Date()) => Number(new Date(d).toLocaleString('en-US', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }));
export function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export function dayRange(from, to) { // inclusive, capped so a typo can't ask for decades
  const out = [];
  for (let d = from; d <= to && out.length < 800; d = addDays(d, 1)) out.push(d);
  return out;
}
export const isDay = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(s));
export const isMonth = s => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || ''));
export function monthDays(ym) {
  const [y, m] = ym.split('-').map(Number);
  return dayRange(`${ym}-01`, new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10));
}

/* ---------- Blobs (store "haha") ---------- */
let testStore = null;
export function setStoreForTests(s) { testStore = s; } // tests
export async function hahaStore(injected) {
  if (injected) return injected;
  if (testStore) return testStore;
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name: STORE_NAME, consistency: 'strong' });
}
// A missing key gives `fallback`; a failed read THROWS — a merge must never start from a blank it only imagined.
export async function readJSON(store, key, fallback = null) {
  const v = await store.get(key, { type: 'json' });
  return v ?? fallback;
}
// Write only when the content changed, so a repeat sync is a no-op.
export async function writeIfChanged(store, key, value, current) {
  if (current !== undefined && JSON.stringify(current) === JSON.stringify(value)) return false;
  await store.setJSON(key, value);
  return true;
}

/* ---------- rate limiting: ~100/min per API type, ~600/min per merchant → stay under both ---------- */
export function makeLimiter({ perType = 80, total = 400, windowMs = 60_000, now = () => Date.now() } = {}) {
  const hits = new Map(), all = [];
  const prune = (arr, t) => { while (arr.length && arr[0] <= t - windowMs) arr.shift(); };
  return {
    async take(type, sleep) {
      for (;;) {
        const t = now(), list = hits.get(type) || [];
        prune(list, t); prune(all, t);
        if (list.length < perType && all.length < total) { list.push(t); all.push(t); hits.set(type, list); return; }
        const oldest = Math.min(list.length >= perType ? list[0] : Infinity, all.length >= total ? all[0] : Infinity);
        await sleep(Math.max(25, oldest + windowMs - t));
      }
    },
  };
}
const sharedLimiter = makeLimiter();
const realSleep = ms => new Promise(r => setTimeout(r, ms));
const apiType = path => path.split('/').filter(Boolean)[0] || 'other';
export const backoffMs = (attempt, rand = Math.random) => Math.min(8000, 500 * 2 ** attempt) * (0.75 + rand() * 0.5);

/* ---------- token: cached in Blobs, refreshed when <2 days remain or on a 401 ---------- */
const TOKEN_KEY = 'auth/token';
const REFRESH_MS = 2 * 864e5;

async function unwrap(r, path) {
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (r.status === 429 || body?.code === -429) throw new HahaError('rate limited', { status: 429, code: -429, path });
  if (!r.ok) throw new HahaError(`HTTP ${r.status}${body?.message ? `: ${body.message}` : ''}`, { status: r.status, code: body?.code, path });
  if (!body || typeof body !== 'object') throw new HahaError('response was not JSON', { status: r.status, path });
  if (body.code !== 0) throw new HahaError(`HAHA code ${body.code}: ${body.message || 'error'}`, { status: r.status, code: body.code, path });
  return body.data;
}

export async function getToken({ store, fetchImpl = fetch, force = false, now = Date.now() } = {}) {
  const env = hahaEnv();
  if (!force) {
    let cached = null;
    try { cached = await readJSON(store, TOKEN_KEY); } catch { /* unreadable cache → fetch a new token */ }
    if (cached?.token && cached.env === env && cached.expires_at * 1000 - now > REFRESH_MS) return cached.token;
  }
  const appkey = process.env.HAHA_APPKEY, appsecret = process.env.HAHA_APPSECRET;
  if (!appkey || !appsecret) throw new HahaError('HAHA_APPKEY / HAHA_APPSECRET are not set');
  const path = '/open/auth/token';
  let r;
  try {
    r = await fetchImpl(baseUrl() + path, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ appkey, appsecret }), signal: AbortSignal.timeout(15_000),
    });
  } catch (e) { throw new HahaError(`token request failed: ${e.message}`, { path }); }
  const data = await unwrap(r, path);
  if (!data?.token) throw new HahaError('token response had no token', { path });
  const rec = {
    token: data.token, token_type: data.token_type || 'Bearer', env,
    expires_at: Number(data.expires_at) || Math.floor(now / 1000) + 15 * 86400,
    fetched_at: new Date(now).toISOString(),
  };
  try { await store.setJSON(TOKEN_KEY, rec); } catch { /* still good for this run */ }
  return rec.token;
}

/* ---------- requests ---------- */
const READ_POSTS = new Set(['/products/batch']); // POST used as a batch READ; every other POST is a Phase 5 write
const MAX_TRIES = 5;

export async function hahaFetch(path, { query, body, method = 'GET', store, fetchImpl = fetch, sleep = realSleep, limiter = sharedLimiter, rand = Math.random } = {}) {
  method = method.toUpperCase();
  if (method !== 'GET' && !(method === 'POST' && READ_POSTS.has(path))) throw new HahaError(`write call blocked until Phase 5: ${method} ${path}`, { path });
  const url = new URL(baseUrl() + PREFIX + path);
  for (const [k, v] of Object.entries(query || {})) if (v != null && v !== '') url.searchParams.set(k, String(v));
  let reauthed = false;
  for (let attempt = 0; ; attempt++) {
    const token = await getToken({ store, fetchImpl });
    await limiter.take(apiType(path), sleep); // counted right before the request leaves, after any token fetch
    let r;
    try {
      r = await fetchImpl(url, {
        method, signal: AbortSignal.timeout(20_000),
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (attempt < MAX_TRIES - 1) { await sleep(backoffMs(attempt, rand)); continue; }
      throw new HahaError(`network: ${e.message}`, { path });
    }
    if (r.status === 401 && !reauthed) { // token revoked or expired early: one fresh token, same attempt
      reauthed = true;
      await getToken({ store, fetchImpl, force: true });
      attempt--;
      continue;
    }
    try { return await unwrap(r, path); } catch (e) {
      const retry = e.status === 429 || e.code === -429 || e.status >= 500;
      if (retry && attempt < MAX_TRIES - 1) { await sleep(backoffMs(attempt, rand)); continue; }
      throw e;
    }
  }
}

/* Every item of a list endpoint. Follows next_cursor (passed back as-is); without one, a cursor walk has ended.
   An endpoint that never returns a cursor is walked by page until a short page or `total` is reached. */
export async function* paginate(path, query = {}, opts = {}) {
  let cursor = null, page = 1, seen = 0;
  for (let i = 0; i < 2000; i++) {
    const data = await hahaFetch(path, { ...opts, query: { ...query, page_size: 100, ...(cursor ? { cursor } : { page }) } });
    const list = Array.isArray(data?.list) ? data.list : [];
    for (const it of list) yield it;
    seen += list.length;
    if (data?.next_cursor) { cursor = data.next_cursor; continue; }
    if (cursor) return;
    const size = Number(data?.page_size) || 100;
    if (!list.length || list.length < size || (data?.total != null && seen >= Number(data.total))) return;
    page++;
  }
  throw new HahaError(`pagination did not end for ${path}`, { path });
}
export async function fetchAll(path, query, opts) {
  const out = [];
  for await (const it of paginate(path, query, opts)) out.push(it);
  return out;
}

/* ---------- webhooks: hex(HMAC-SHA256(secret, raw body bytes)), timestamp within 5 minutes ---------- */
export function signBody(raw, secret) {
  return createHmac('sha256', secret).update(raw).digest('hex');
}
export function verifyWebhook({ raw, signature, timestamp, secret, now = Date.now(), toleranceSec = 300 }) {
  if (!secret) return { ok: false, status: 503, error: 'HAHA_WEBHOOK_SECRET is not set' };
  const ts = String(timestamp ?? '').trim();
  if (!/^\d{9,11}$/.test(ts)) return { ok: false, status: 401, error: 'bad timestamp' };
  if (Math.abs(now / 1000 - Number(ts)) > toleranceSec) return { ok: false, status: 401, error: 'stale timestamp' };
  const sig = String(signature ?? '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(sig)) return { ok: false, status: 401, error: 'bad signature' };
  const want = createHmac('sha256', secret).update(raw).digest();
  return timingSafeEqual(Buffer.from(sig, 'hex'), want) ? { ok: true } : { ok: false, status: 401, error: 'bad signature' };
}
