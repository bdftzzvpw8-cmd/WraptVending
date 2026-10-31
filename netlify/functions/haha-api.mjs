/* HAHA machines API — what /machines.html, Command and JARVIS read. Everything comes from Blobs; nothing calls HAHA.
     GET  ?view=summary[&format=text]                      fleet status, revenue today / 7 days / month, active alerts
     GET  ?view=sales&from=&to=[&market=]                  per machine × day, top products, refunds (≤ 93 days)
     GET  ?view=orders&day=[&market=][&product=][&refunds=1]  the raw sales behind any number
     GET  ?view=restock                                    low items per machine + combined shopping list
     GET  ?view=machine&id=                                stock by rack, recent sales, restocks, online history
     GET  ?view=statement&host=&month=YYYY-MM              host statement
     GET  ?view=config                                     hosts + settings (defaults until first save)
     GET  ?view=alerts                                     active alerts + recent alert feed
     GET  ?view=state                                      sync state, webhook log
     POST ?view=config  { hosts?, settings?, base? }       save; 409 { conflict } if someone saved since `base`
     POST ?action=sync                                     kick a sync now
   Auth: X-Dash-Key header (same key as Command). */
import { dashKeyDenied } from './lib/dash-key.mjs';
import { hahaStore, readJSON, centralDay, addDays, dayRange, isDay, isMonth, monthDays } from './lib/haha.mjs';
import { readDays, prevMonth } from './lib/haha-data.mjs';
import { summary, summaryText, summaryDays, salesRange, orders, restock, machine } from './lib/haha-views.mjs';
import { buildStatement, validateHosts, validateSettings, DEFAULT_HOSTS, DEFAULT_SETTINGS } from './lib/haha-statement.mjs';
import { kickWorker, siteOf, STATE_KEY } from './lib/haha-sync-core.mjs';
import { json } from './lib/wrapt-agents.mjs';

const bad = msg => json({ error: msg }, 400);

async function loadConfig(store) {
  const [h, s] = await Promise.all([readJSON(store, 'config/hosts'), readJSON(store, 'config/settings')]);
  return {
    hosts: h?.hosts || DEFAULT_HOSTS, settings: { ...DEFAULT_SETTINGS, ...(s?.settings || {}) },
    updated: [h?.updated, s?.updated].filter(Boolean).sort().at(-1) || null, seeded: !h,
  };
}

async function get(store, u) {
  const p = k => u.searchParams.get(k) || '';
  const now = new Date(), today = centralDay(now);
  switch (p('view') || 'summary') {
    case 'summary': {
      const [markets, inventory, planograms, alerts, syncState, days] = await Promise.all([
        readJSON(store, 'markets/latest'), readJSON(store, 'inventory/latest'), readJSON(store, 'planograms/latest'),
        readJSON(store, 'alerts/state'), readJSON(store, STATE_KEY), readDays(store, summaryDays(now)),
      ]);
      const s = summary({ now, markets, inventory, planograms, days, alerts, syncState });
      if (p('format') === 'text') return new Response(summaryText(s), { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
      return json(s);
    }
    case 'sales': {
      const to = p('to') || today, from = p('from') || addDays(to, -6);
      if (!isDay(from) || !isDay(to) || from > to) return bad('from/to must be YYYY-MM-DD, from ≤ to');
      if (dayRange(from, to).length > 93) return bad('at most 93 days at a time');
      const [markets, days] = await Promise.all([readJSON(store, 'markets/latest'), readDays(store, dayRange(from, to))]);
      return json(salesRange({ from, to, days, markets, marketId: p('market') }));
    }
    case 'orders': {
      const day = p('day');
      if (!isDay(day)) return bad('day must be YYYY-MM-DD');
      const days = await readDays(store, [day]);
      return json({ day, orders: orders({ day, days, marketId: p('market'), productId: p('product'), refundsOnly: p('refunds') === '1' }) });
    }
    case 'restock': {
      const [markets, inventory, planograms, products, cfg] = await Promise.all([
        readJSON(store, 'markets/latest'), readJSON(store, 'inventory/latest'), readJSON(store, 'planograms/latest'),
        readJSON(store, 'products/latest'), loadConfig(store),
      ]);
      return json({ updated: inventory?.updated || null, ...restock({ markets, inventory, planograms, products, settings: cfg.settings }) });
    }
    case 'machine': {
      const id = p('id');
      if (!id) return bad('id required');
      const month = today.slice(0, 7);
      const [markets, inventory, planograms, products, days, r1, r2, onlineLog] = await Promise.all([
        readJSON(store, 'markets/latest'), readJSON(store, 'inventory/latest'), readJSON(store, 'planograms/latest'),
        readJSON(store, 'products/latest'), readDays(store, dayRange(addDays(today, -6), today)),
        readJSON(store, `restocks/${month}`), readJSON(store, `restocks/${prevMonth(month)}`), readJSON(store, 'markets/online-log'),
      ]);
      const restocks = [...Object.values(r1?.records || {}), ...Object.values(r2?.records || {})];
      const m = machine({ id, now, markets, inventory, planograms, products, days, restocks, onlineLog });
      return m ? json(m) : json({ error: 'unknown machine' }, 404);
    }
    case 'statement': {
      const month = p('month');
      if (!isMonth(month)) return bad('month must be YYYY-MM');
      const cfg = await loadConfig(store);
      const host = cfg.hosts.find(h => h.hostId === p('host'));
      if (!host) return json({ error: 'unknown host' }, 404);
      const [markets, days] = await Promise.all([readJSON(store, 'markets/latest'), readDays(store, monthDays(month))]);
      const st = buildStatement({ host, month, days, settings: cfg.settings, machines: markets?.machines || {} });
      if (st.error) return json(st, 422);
      return json({ ...st, generated_at: now.toISOString(), partial: month >= today.slice(0, 7) });
    }
    case 'config': {
      const [cfg, markets] = await Promise.all([loadConfig(store), readJSON(store, 'markets/latest')]);
      return json({ ...cfg, machines: Object.values(markets?.machines || {}).map(m => ({ id: m.id, name: m.name, status: m.status })) });
    }
    case 'alerts': {
      const [active, feed] = await Promise.all([readJSON(store, 'alerts/state'), readJSON(store, 'alerts/feed')]);
      return json({ active: Object.values(active?.active || {}), feed: (feed?.events || []).slice(-100).reverse() });
    }
    case 'state': {
      const [state, log, emailed] = await Promise.all([readJSON(store, STATE_KEY), readJSON(store, 'webhook/log'), readJSON(store, 'alerts/emailed')]);
      const { blobs } = await store.list({ prefix: 'webhook/sample/' });
      return json({
        state, emailed, webhooks: (log?.events || []).slice(-30).reverse(), samples: blobs.map(b => b.key.slice('webhook/sample/'.length)),
        configured: { appkey: !!process.env.HAHA_APPKEY, appsecret: !!process.env.HAHA_APPSECRET, webhookSecret: !!process.env.HAHA_WEBHOOK_SECRET, alertTo: !!process.env.HAHA_ALERT_TO, env: (process.env.HAHA_ENV || 'test').toLowerCase() },
      });
    }
    default: return bad('unknown view');
  }
}

async function post(store, u, req, context) {
  if (u.searchParams.get('action') === 'sync') {
    if (!process.env.HAHA_APPKEY || !process.env.HAHA_APPSECRET) return json({ error: 'HAHA_APPKEY / HAHA_APPSECRET are not set' }, 503);
    try { await kickWorker(siteOf(context), { mode: 'regular' }); } catch (e) { return json({ error: e.message }, 502); }
    return json({ queued: true, since: new Date().toISOString() });
  }
  if (u.searchParams.get('view') !== 'config') return bad('unknown action');
  let body;
  try { body = await req.json(); } catch { return bad('bad json'); }
  if (JSON.stringify(body || {}).length > 100 * 1024) return json({ error: 'too large' }, 413);
  const cur = await loadConfig(store);
  if (body?.base !== undefined && cur.updated && (!body.base || cur.updated > String(body.base))) {
    return json({ error: 'conflict', ...cur }, 409);
  }
  // validate both before writing either, so a bad fee never leaves the hosts half-saved
  const h = body?.hosts !== undefined ? validateHosts(body.hosts) : null;
  const s = body?.settings !== undefined ? validateSettings(body.settings) : null;
  if (h?.error || s?.error) return bad(h?.error || s?.error);
  const updated = new Date().toISOString();
  if (h) await store.setJSON('config/hosts', { updated, hosts: h.hosts });
  if (s) await store.setJSON('config/settings', { updated, settings: s.settings });
  return json({ ok: true, ...(await loadConfig(store)) });
}

export default async (req, context) => {
  const denied = dashKeyDenied(req);
  if (denied) return denied;
  const u = new URL(req.url);
  try {
    const store = await hahaStore();
    if (req.method === 'GET') return await get(store, u);
    if (req.method === 'POST') return await post(store, u, req, context);
    return json({ error: 'method' }, 405);
  } catch (e) {
    console.error('[haha-api]', u.searchParams.get('view') || u.searchParams.get('action'), e.message);
    return json({ error: 'could not read machine data, try again' }, 503);
  }
};
