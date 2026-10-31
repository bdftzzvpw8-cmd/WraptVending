/* =====================================================================
   HAHA sync — pulls the read endpoints into Blobs (store "haha")
   ---------------------------------------------------------------------
   Modes
     regular   every 15 min: markets, products, inventory, sales (yesterday + today),
               restocks (7 days); planograms when >55 min old; once a day after 2am
               Central the nightly pass re-pulls 7 days of sales and prunes webhook markers.
     light     the scheduled function's inline fallback (30 s limit): markets + today's sales.
     poke      a webhook arrived: pull only the resources it touched (webhook/dirty).
     backfill  sales from `from` to `to`, one day per request, under the rate limit.
   Every resource is fetched in full before anything is written; a failure keeps the
   last good data and is recorded in sync/state. Alerts run at the end of regular/poke runs.
   ===================================================================== */
import { hahaStore, readJSON, fetchAll, hahaFetch, centralDay, centralHour, addDays, dayRange, hahaEnv } from './haha.mjs';
import { makeWarn, normalizeMarket, mergeMarkets, normalizeProduct, pivotInventory, planogramCapacity, normalizeSale, upsertSales, upsertRestocks } from './haha-data.mjs';
import { runAlerts, emailAlerts } from './haha-alerts.mjs';

export const STATE_KEY = 'sync/state';
const LOCK_MS = 10 * 60e3;
const PLANOGRAM_EVERY_MS = 55 * 60e3;

/* webhook vdiType → the resource a fresh pull should cover (event names from the roadmap's subscription list) */
export const VDI_RESOURCE = { mmsSales: 'sales', mmsPlanograms: 'inventory', mmsMarkets: 'markets', mmsRestocks: 'restocks', mmsProducts: 'products' };

const saveDoc = async (store, key, field, value, nowISO) => { // rewrite only when the payload changed
  const cur = await readJSON(store, key);
  if (cur && JSON.stringify(cur[field]) === JSON.stringify(value)) return false;
  await store.setJSON(key, { updated: nowISO, [field]: value });
  return true;
};

const RESOURCES = {
  async markets(ctx) {
    const list = (await fetchAll('/markets', {}, ctx.http)).map(m => normalizeMarket(m, ctx.warn)).filter(Boolean);
    const cur = await readJSON(ctx.store, 'markets/latest');
    if (!list.length && Object.keys(cur?.machines || {}).length) { ctx.warn('markets: HAHA returned no machines — kept the previous list'); return { count: 0 }; }
    const { machines, events } = mergeMarkets(cur, list, ctx.nowISO);
    await ctx.store.setJSON('markets/latest', { updated: ctx.nowISO, machines });
    if (events.length) {
      const log = await readJSON(ctx.store, 'markets/online-log', { events: [] });
      await ctx.store.setJSON('markets/online-log', { events: [...log.events, ...events].slice(-500) });
    }
    return { count: list.length, transitions: events.length };
  },

  async products(ctx) {
    const list = (await fetchAll('/products', {}, ctx.http)).map(p => normalizeProduct(p, ctx.warn)).filter(Boolean);
    if (!list.length) { ctx.warn('products: HAHA returned no products — kept the previous catalog'); return { count: 0 }; }
    const wrote = await saveDoc(ctx.store, 'products/latest', 'products', Object.fromEntries(list.map(p => [p.id, p])), ctx.nowISO);
    return { count: list.length, wrote };
  },

  async inventory(ctx) {
    const machines = pivotInventory(await fetchAll('/inventory/products', {}, ctx.http), ctx.warn);
    if (!Object.keys(machines).length) { ctx.warn('inventory: HAHA returned no stock — kept the previous inventory'); return { count: 0 }; }
    const wrote = await saveDoc(ctx.store, 'inventory/latest', 'machines', machines, ctx.nowISO);
    return { count: Object.keys(machines).length, wrote };
  },

  async planograms(ctx) {
    const ids = Object.keys((await readJSON(ctx.store, 'markets/latest'))?.machines || {});
    const cur = (await readJSON(ctx.store, 'planograms/latest'))?.machines || {};
    const machines = { ...cur }, failed = [];
    for (const id of ids) {
      try {
        const raw = await hahaFetch(`/markets/${encodeURIComponent(id)}/planograms`, ctx.http);
        machines[id] = { capacity: planogramCapacity(raw), raw };
      } catch (e) { failed.push(`${id}: ${e.message}`); } // keep that machine's last layout
    }
    if (ids.length && Object.values(machines).every(m => !Object.keys(m.capacity || {}).length)) ctx.warn('planograms: no slot capacity recognised — restock list uses the units rule');
    const wrote = await saveDoc(ctx.store, 'planograms/latest', 'machines', machines, ctx.nowISO);
    if (failed.length) throw new Error(`planograms failed for ${failed.length}/${ids.length}: ${failed.slice(0, 3).join('; ')}`);
    return { count: ids.length, wrote };
  },

  // [from, to] Central days. end_time is sent as the day AFTER `to`, so the pull is complete whether HAHA treats
  // end_time as inclusive or exclusive; every sale is filed under its own saleDtm day either way.
  async sales(ctx, { from, to }) {
    const raw = await fetchAll('/sales', { start_time: from, end_time: addDays(to, 1), sort: 'pay_time_asc' }, ctx.http);
    const sales = raw.map(s => normalizeSale(s, ctx.warn)).filter(Boolean);
    const r = await upsertSales(ctx.store, sales, ctx.nowISO);
    return { count: sales.length, ...r, from, to };
  },

  async restocks(ctx) {
    const raw = await fetchAll('/restock/records', { start_time: addDays(ctx.today, -6), end_time: addDays(ctx.today, 1) }, ctx.http);
    return { count: raw.length, ...(await upsertRestocks(ctx.store, raw, ctx.nowISO)) };
  },
};

async function pruneWebhookMarkers(store, today) {
  const cutoff = addDays(today, -7);
  const { blobs } = await store.list({ prefix: 'webhook/seen/' });
  const old = blobs.map(b => b.key).filter(k => (k.split('/')[2] || '') < cutoff);
  for (const k of old) await store.delete(k);
  return old.length;
}

async function takeLock(store, key, now) {
  const lock = await readJSON(store, key).catch(() => null);
  if (lock?.at && now - new Date(lock.at) < LOCK_MS) return false;
  await store.setJSON(key, { at: new Date(now).toISOString() });
  return true;
}

export async function runSync({ store: injected, now = new Date(), mode = 'regular', from, to, http = {}, alerts = true } = {}) {
  const t0 = Date.now(), store = await hahaStore(injected);
  const nowISO = now.toISOString(), today = centralDay(now), yday = addDays(today, -1);
  const warn = makeWarn(), errors = [], results = {};
  const ctx = { store, now, nowISO, today, warn, http: { store, ...http } };
  const state = (await readJSON(store, STATE_KEY).catch(() => null)) || { resources: {} };
  state.resources ||= {};
  state.env = hahaEnv();

  const lockKey = mode === 'poke' ? 'sync/lock-poke' : mode === 'backfill' ? 'sync/lock-backfill' : 'sync/lock';
  if (!(await takeLock(store, lockKey, now))) return { skipped: `another ${mode} sync is running`, mode };

  const run = async (name, fn) => {
    const s = Date.now();
    try {
      results[name] = await fn();
      state.resources[name] = { ...state.resources[name], ok_at: nowISO, ms: Date.now() - s, count: results[name]?.count ?? null, error: null };
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
      state.resources[name] = { ...state.resources[name], error: { at: nowISO, message: e.message } };
    }
  };

  try {
    if (mode === 'backfill') {
      const days = dayRange(from, to);
      state.backfill = { from, to, started: nowISO, done: 0, total: days.length, failed: [], finished: null };
      await store.setJSON(STATE_KEY, state);
      for (const d of days) {
        try { await RESOURCES.sales(ctx, { from: d, to: d }); } catch (e) { state.backfill.failed.push(`${d}: ${e.message}`); }
        state.backfill.done++;
        if (state.backfill.done % 5 === 0) await store.setJSON(STATE_KEY, state).catch(() => {});
      }
      state.backfill.finished = new Date().toISOString();
      if (state.backfill.failed.length) errors.push(`backfill: ${state.backfill.failed.length} day(s) failed`);
    } else if (mode === 'poke') {
      // webhooks that land while this runs are picked up by the next round (the lock keeps a second worker out)
      const done = state.poked || {};
      for (let round = 0; round < 3; round++) {
        const roundAt = new Date().toISOString();
        const dirty = (await readJSON(store, 'webhook/dirty').catch(() => null)) || {};
        const due = ['markets', 'products', 'inventory', 'sales', 'restocks'].filter(r => dirty[r] && !(done[r] && done[r] >= dirty[r]));
        if (!due.length) break;
        for (const res of due) {
          await run(res, () => (res === 'sales' ? RESOURCES.sales(ctx, { from: yday, to: today }) : RESOURCES[res](ctx)));
          done[res] = roundAt;
        }
      }
      state.poked = done;
    } else if (mode === 'light') {
      await run('markets', () => RESOURCES.markets(ctx));
      await run('sales', () => RESOURCES.sales(ctx, { from: today, to: today }));
    } else {
      const nightly = state.lastNightly !== today && centralHour(now) >= 2;
      await run('markets', () => RESOURCES.markets(ctx));
      await run('products', () => RESOURCES.products(ctx));
      await run('inventory', () => RESOURCES.inventory(ctx));
      const pAge = state.resources.planograms?.ok_at ? now - new Date(state.resources.planograms.ok_at) : Infinity;
      if (pAge > PLANOGRAM_EVERY_MS) await run('planograms', () => RESOURCES.planograms(ctx));
      await run('sales', () => RESOURCES.sales(ctx, { from: nightly ? addDays(today, -6) : yday, to: today }));
      await run('restocks', () => RESOURCES.restocks(ctx));
      if (nightly) {
        try { results.pruned = await pruneWebhookMarkers(store, today); state.lastNightly = today; } catch (e) { errors.push(`nightly: ${e.message}`); }
      }
    }

    state.lastRun = { at: nowISO, mode, ok: !errors.length, ms: Date.now() - t0, errors, warnings: warn.list };
    if (!errors.length && mode !== 'backfill') state.lastOk = nowISO;

    if (alerts && (mode === 'regular' || mode === 'poke' || mode === 'light')) {
      try {
        const a = await runAlerts({ store, now, syncState: state });
        results.alerts = { raised: a.raised.length, cleared: a.cleared.length, active: a.active.length };
        const mail = await emailAlerts({ store, now, events: a.events });
        if (mail.error) errors.push(`alert email: ${mail.error}`);
        results.alerts.email = mail.sent ? 'sent' : mail.skipped || null;
      } catch (e) { errors.push(`alerts: ${e.message}`); }
      state.lastRun.errors = errors;
    }
  } finally {
    try { await store.setJSON(STATE_KEY, state); } catch (e) { errors.push(`state: ${e.message}`); }
    try { await store.delete(lockKey); } catch { /* expires on its own */ }
  }
  return { mode, ok: !errors.length, errors, warnings: warn.list, results, ms: Date.now() - t0 };
}

/* fire the background worker and return at once (schedule, "Sync now", backfill, webhooks) */
export async function kickWorker(site, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${String(site).replace(/\/$/, '')}/.netlify/functions/haha-sync-background${qs ? `?${qs}` : ''}`, {
    method: 'POST', headers: { 'X-Dash-Key': process.env.DASH_KEY || '', 'content-type': 'application/json' }, body: '{}',
    signal: AbortSignal.timeout(8000),
  });
  if (r.status !== 202 && !r.ok) throw new Error(`haha-sync-background: HTTP ${r.status}`);
  return r.status;
}
export const siteOf = context => (context?.site?.url || process.env.URL || 'http://localhost:8888').replace(/\/$/, '');
