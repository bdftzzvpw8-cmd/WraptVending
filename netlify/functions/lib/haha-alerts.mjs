/* =====================================================================
   HAHA alerts — evaluated at the end of every sync
   ---------------------------------------------------------------------
   Rules (ALERT_RULES): machine offline > 30 min (and a note when it's back),
   no sales in 24 h while online, a product out of stock, machine < 25 %
   stocked (only when planogram capacity is known), ≥ 3 refunds in a day on
   one machine, no successful sync in 1 hour.
   Each condition notifies once when it starts and stays quiet until it clears.
   Delivery: alerts/state (active), alerts/feed (history) for the dashboard,
   Command and JARVIS; an email digest to HAHA_ALERT_TO. No SMS.
   ===================================================================== */
import { readJSON, centralDay, addDays, fmt } from './haha.mjs';
import { readDays, saleFigures } from './haha-data.mjs';

export const ALERT_RULES = { offlineMin: 30, quietHours: 24, lowPercent: 25, refundSpike: 3, syncStaleMin: 60 };
const MIN = 60e3, HOUR = 60 * MIN;

export function ago(ms) {
  const m = Math.max(0, Math.round(ms / MIN));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)} days`;
}

export function stockPercent(invMachine, capacity) {
  if (!invMachine || !capacity || !Object.keys(capacity).length) return null;
  let have = 0, cap = 0;
  for (const [pid, c] of Object.entries(capacity)) { if (c > 0) { cap += c; have += Math.min(c, Math.max(0, invMachine.products?.[pid]?.stock || 0)); } }
  return cap ? Math.round((have / cap) * 100) : null;
}

/* the conditions that hold right now — pure, so tests can feed it any fleet */
export function evaluate({ now, markets, inventory, planograms, products, days, syncState }) {
  const out = [], today = centralDay(now);
  const machines = Object.values(markets?.machines || {});
  const nameOf = pid => products?.products?.[pid]?.name || pid;

  const lastSale = {}, refundsToday = {};
  for (const [day, sales] of Object.entries(days || {})) {
    for (const s of Object.values(sales)) {
      const f = saleFigures(s);
      if (!f.counted) continue;
      if (!lastSale[s.marketId] || s.at > lastSale[s.marketId]) lastSale[s.marketId] = s.at;
      if (day === today && f.refunded) {
        const r = (refundsToday[s.marketId] ||= { n: 0, cents: 0 });
        r.n++;
        r.cents += f.refundNet;
      }
    }
  }

  for (const m of machines) {
    if (m.status && m.status !== 'ACTIVE') continue; // NOT_ACTIVE / FROZEN / RETURNED machines don't alert
    const base = { marketId: m.id, machine: m.name };
    const since = m.since ? now - new Date(m.since) : 0;
    if (!m.online && since > ALERT_RULES.offlineMin * MIN) {
      out.push({ ...base, key: `offline:${m.id}`, kind: 'offline', level: 'red', text: `${m.name} offline for ${ago(since)}` });
    }
    const watched = now - new Date(m.firstSeen || now) > ALERT_RULES.quietHours * HOUR;
    const quiet = !lastSale[m.id] || now - new Date(lastSale[m.id]) > ALERT_RULES.quietHours * HOUR;
    if (m.online && watched && quiet) {
      out.push({ ...base, key: `quiet:${m.id}`, kind: 'quiet', level: 'amber', text: `${m.name}: no sales in ${ALERT_RULES.quietHours}h while online — check the card reader and door` });
    }
    const inv = inventory?.machines?.[m.id];
    for (const [pid, p] of Object.entries(inv?.products || {})) {
      if (p.stock <= 0) out.push({ ...base, key: `oos:${m.id}:${pid}`, kind: 'oos', level: 'amber', product: nameOf(pid) || p.name, text: `${m.name}: ${nameOf(pid) || p.name} is out of stock` });
    }
    const pct = stockPercent(inv, planograms?.machines?.[m.id]?.capacity);
    if (pct != null && pct < ALERT_RULES.lowPercent) {
      out.push({ ...base, key: `low:${m.id}`, kind: 'low', level: 'amber', text: `${m.name} is ${pct}% stocked` });
    }
    const r = refundsToday[m.id];
    if (r && r.n >= ALERT_RULES.refundSpike) {
      out.push({ ...base, key: `refunds:${m.id}:${today}`, kind: 'refunds', level: 'red', text: `${m.name}: ${r.n} refunds today (${fmt(r.cents)})` });
    }
  }

  const lastOk = syncState?.lastOk ? new Date(syncState.lastOk) : null;
  if (syncState?.lastRun && (!lastOk || now - lastOk > ALERT_RULES.syncStaleMin * MIN)) {
    const why = syncState.lastRun.errors?.[0] || 'no successful run';
    out.push({ key: 'sync:failing', kind: 'sync', level: 'red', text: `HAHA sync failing${lastOk ? ` — last good run ${ago(now - lastOk)} ago` : ''}: ${why}` });
  }
  return out;
}

function clearedText(a, now) {
  const dur = a.since ? ago(now - new Date(a.since)) : '';
  switch (a.kind) {
    case 'offline': return `${a.machine} back online${dur ? ` (alert open ${dur})` : ''}`;
    case 'quiet': return `${a.machine} is selling again`;
    case 'oos': return `${a.machine}: ${a.product || 'product'} back in stock`;
    case 'low': return `${a.machine} restocked`;
    case 'sync': return 'HAHA sync recovered';
    default: return null; // a refund spike just ends with the day
  }
}

export async function runAlerts({ store, now = new Date(), syncState }) {
  const today = centralDay(now);
  const [markets, inventory, planograms, products, prev, feed, days] = await Promise.all([
    readJSON(store, 'markets/latest'), readJSON(store, 'inventory/latest'), readJSON(store, 'planograms/latest'),
    readJSON(store, 'products/latest'), readJSON(store, 'alerts/state'), readJSON(store, 'alerts/feed'),
    readDays(store, [addDays(today, -2), addDays(today, -1), today]),
  ]);
  const nowISO = now.toISOString();
  const conds = evaluate({ now, markets, inventory, planograms, products, days, syncState });
  const was = prev?.active || {}, active = {}, raised = [], cleared = [];
  for (const c of conds) {
    if (was[c.key]) active[c.key] = { ...was[c.key], text: c.text };
    else { active[c.key] = { ...c, since: nowISO }; raised.push(active[c.key]); }
  }
  for (const [k, a] of Object.entries(was)) if (!active[k]) cleared.push(a);

  const events = [
    ...raised.map(a => ({ at: nowISO, type: 'raised', key: a.key, kind: a.kind, level: a.level, marketId: a.marketId || null, text: a.text })),
    ...cleared.map(a => ({ at: nowISO, type: 'cleared', key: a.key, kind: a.kind, level: 'ok', marketId: a.marketId || null, text: clearedText(a, now) })).filter(e => e.text),
  ];
  await store.setJSON('alerts/state', { updated: nowISO, active });
  if (events.length) await store.setJSON('alerts/feed', { events: [...(feed?.events || []), ...events].slice(-300) });
  return { raised, cleared, active: Object.values(active), events };
}

/* one email per sync that raised something (and for machines coming back online) — never for routine restocks */
export async function emailAlerts({ store, now = new Date(), events = [], transport, from }) {
  const to = process.env.HAHA_ALERT_TO;
  const mail = events.filter(e => e.type === 'raised' || (e.type === 'cleared' && (e.kind === 'offline' || e.kind === 'sync')));
  if (!mail.length) return { skipped: 'nothing new' };
  if (!to) return { skipped: 'HAHA_ALERT_TO not set' };
  try {
    const agents = await import('./wrapt-agents.mjs');
    if (!transport && !agents.smtpConfig().ok) return { skipped: 'SMTP not configured' };
    const tr = transport || (await agents.makeTransport());
    const lines = mail.map(e => `${e.type === 'cleared' ? '✓' : e.level === 'red' ? '●' : '○'} ${e.text}`);
    const site = (process.env.URL || 'https://wraptvending.com').replace(/\/$/, '');
    const text = [...lines, '', `Dashboard: ${site}/machines.html`, `Sent ${now.toLocaleString('en-US', { timeZone: 'America/Chicago' })} Central.`].join('\n');
    await tr.sendMail({
      from: from || agents.smtpConfig().from, to,
      subject: `Wrapt machines — ${mail.length === 1 ? mail[0].text : `${mail.length} alerts: ${mail[0].text}`}`.slice(0, 140),
      text,
    });
    await store.setJSON('alerts/emailed', { at: now.toISOString(), count: mail.length }).catch(() => {});
    return { sent: true, count: mail.length };
  } catch (e) { return { error: e.message }; }
}
